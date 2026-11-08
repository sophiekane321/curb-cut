// Curb Cut: turns the paths into a "graph" and finds routes through it.
//
// A graph is a set of points (called nodes) and the pieces of path that
// connect them (called edges). Where two paths meet, they share a node,
// so a route can turn there.

// Distance in meters between two [longitude, latitude] points
function distanceInMeters(a, b) {
  const EARTH_RADIUS = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a[1])) * Math.cos(toRadians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

// Find the spot on the straight line from a to b that's closest to point p.
// Returns how far p is from it (in meters) and how far along the line it is
// (t: 0 = at a, 1 = at b).
function closestOnSegment(p, a, b) {
  const METERS_PER_DEGREE = 111195;
  const squeeze = Math.cos((p[1] * Math.PI) / 180); // longitude lines get closer together away from the equator
  const ax = (a[0] - p[0]) * squeeze, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * squeeze, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return { meters: METERS_PER_DEGREE * Math.hypot(ax + t * dx, ay + t * dy), t: t };
}

// Distance in meters from point p to the straight line between a and b
function distanceToSegment(p, a, b) {
  return closestOnSegment(p, a, b).meters;
}

// Add a node to the graph (if it isn't there yet) and return its name.
// Each node is stored under a name made from its coordinates, like "-78.94,36.00".
function addNode(graph, coord) {
  const key = coord.join(",");
  if (!graph.has(key)) graph.set(key, { coord: coord, edges: [] });
  return key;
}

// Connect two points with a piece of path that goes both ways.
// Both directions share one "notes" object, so marking one direction
// (for example, "this is stairs") marks the other too.
function addEdge(graph, coordA, coordB, properties) {
  const a = addNode(graph, coordA);
  const b = addNode(graph, coordB);
  const length = distanceInMeters(coordA, coordB);
  const notes = {};
  graph.get(a).edges.push({ to: b, length: length, properties: properties, notes: notes });
  graph.get(b).edges.push({ to: a, length: length, properties: properties, notes: notes });
}

// Build the graph from the paths file
function buildGraph(paths) {
  const graph = new Map();
  for (const feature of paths.features) {
    const coords = feature.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      addEdge(graph, coords[i], coords[i + 1], feature.properties);
    }
  }
  keepLargestPiece(graph);
  return graph;
}

// A few paths (like hallways inside buildings) don't connect to anything else.
// A route that starts on one of them could never reach anywhere, so we keep
// only the biggest connected piece of the network.
function keepLargestPiece(graph) {
  const seen = new Set();
  let largest = [];

  for (const start of graph.keys()) {
    if (seen.has(start)) continue;
    // Collect every node reachable from this one
    const piece = [start];
    seen.add(start);
    for (let i = 0; i < piece.length; i++) {
      for (const edge of graph.get(piece[i]).edges) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          piece.push(edge.to);
        }
      }
    }
    if (piece.length > largest.length) largest = piece;
  }

  const keep = new Set(largest);
  for (const key of [...graph.keys()]) {
    if (!keep.has(key)) graph.delete(key);
  }
}

// Find the node closest to a point. Give "allowed" to only consider some nodes.
function nearestNode(graph, latlng, allowed = graph.keys()) {
  const point = [latlng.lng, latlng.lat];
  let bestKey = null;
  let bestDistance = Infinity;
  for (const key of allowed) {
    const d = distanceInMeters(point, graph.get(key).coord);
    if (d < bestDistance) {
      bestDistance = d;
      bestKey = key;
    }
  }
  return bestKey;
}

// Find the piece of path closest to a point, only looking at pieces
// that pass the "fits" test, and only up to maxMeters away.
// Returns the piece, the name of the node it starts from, and how far away it is.
function nearestEdge(graph, coord, fits, maxMeters) {
  let best = null;
  let bestDistance = maxMeters;
  for (const [key, node] of graph) {
    for (const edge of node.edges) {
      if (!fits(edge.properties)) continue;
      const d = distanceToSegment(coord, node.coord, graph.get(edge.to).coord);
      if (d < bestDistance) {
        bestDistance = d;
        best = { edge: edge, from: key, meters: d };
      }
    }
  }
  return best;
}

// A photo this close (in meters) to a path is right on top of it,
// so we trust that the barrier is on that path
const ON_PATH_METERS = 1;

// How close (in meters) a photo has to be to a spot where paths meet
// for us to treat it as "taken where the paths meet"
const JUNCTION_METERS = 6;

// Block the path a barrier photo is on. If the photo is right on top of a path,
// that's the one. But if it was taken between paths where they meet, we can't
// tell which one has the barrier, so we block all of them: a longer route is
// much better than one that goes down stairs.
function blockBarrier(graph, coord, fits, barrier) {
  const nearest = nearestEdge(graph, coord, fits, 15);
  if (!nearest) return;
  nearest.edge.notes.barrier = barrier;
  if (nearest.meters < ON_PATH_METERS) return;

  for (const key of [nearest.from, nearest.edge.to]) {
    const node = graph.get(key);
    const isJunction = node.edges.length >= 3;
    if (isJunction && distanceInMeters(coord, node.coord) < JUNCTION_METERS) {
      for (const edge of node.edges) {
        if (fits(edge.properties)) edge.notes.barrier = barrier;
      }
    }
  }
}

// Stairs are never on a road, a sidewalk along a road, or a crosswalk.
// Skipping those keeps a staircase from blocking the sidewalk right next to it.
function couldBeStairs(properties) {
  const walkways = ["footway", "path", "steps", "pedestrian", "corridor"];
  return walkways.includes(properties.highway) && !["sidewalk", "crossing"].includes(properties.footway);
}

// Add what you found on your walk-through to the graph
function applyWalkthrough(graph, walkthrough) {
  const original = [...graph.keys()]; // the nodes from OpenStreetMap
  const addedEnds = []; // ends of paths added from the walk-through
  const latlng = ([lon, lat]) => ({ lat: lat, lng: lon });
  const byType = (type) => walkthrough.features.filter((f) => f.properties.type === type);

  // 1. Stairs and missing curb cuts block the path they're on.
  // This happens first, so stairs only land on paths from the map,
  // never on the paths and elevators added below.
  for (const feature of [...byType("stairs"), ...byType("missing_curb_cut")]) {
    const { type, photos } = feature.properties;
    const fits = type === "stairs" ? couldBeStairs : () => true;
    blockBarrier(graph, feature.geometry.coordinates, fits, { type: type, photo: photos[0] });
  }

  // Street crossings the map doesn't label: mark the path where it crosses the road
  for (const feature of byType("crossing")) {
    const isWalkway = (properties) => !ROADS.includes(properties.highway);
    const nearest = nearestEdge(graph, feature.geometry.coordinates, isWalkway, 15);
    if (nearest) nearest.edge.notes.crossing = true;
  }

  // 2. Paths missing from the map: add them, and join each end to the nearest path
  for (const feature of byType("missing_path")) {
    const points = feature.geometry.coordinates; // start, any bends, end
    const start = points[0];
    const end = points[points.length - 1];
    const properties = { highway: "footway", name: "Path from walk-through" };
    const startNeighbor = graph.get(nearestNode(graph, latlng(start), original)).coord;
    const endNeighbor = graph.get(nearestNode(graph, latlng(end), original)).coord;
    for (let i = 0; i < points.length - 1; i++) {
      addEdge(graph, points[i], points[i + 1], properties);
    }
    addEdge(graph, start, startNeighbor, properties);
    addEdge(graph, end, endNeighbor, properties);
    addedEnds.push(addNode(graph, start), addNode(graph, end));
  }

  // 3. Elevators: join to the nearest path, and to a walk-through path that ends nearby
  for (const feature of byType("elevator")) {
    const spot = feature.geometry.coordinates;
    const properties = { highway: "elevator", name: "Elevator" };
    addEdge(graph, spot, graph.get(nearestNode(graph, latlng(spot), original)).coord, properties);
    const nearbyEnd = nearestNode(graph, latlng(spot), addedEnds);
    if (nearbyEnd && distanceInMeters(spot, graph.get(nearbyEnd).coord) < 25) {
      addEdge(graph, spot, graph.get(nearbyEnd).coord, properties);
    }
  }

  // 4. Rough and steep stretches: mark every piece of path between the two photos
  for (const feature of [...byType("rough"), ...byType("steep")]) {
    const points = feature.geometry.coordinates;
    const start = points[0];
    const end = points[points.length - 1];
    const stretch = findRoute(
      graph,
      nearestNode(graph, latlng(start), original),
      nearestNode(graph, latlng(end), original),
      standardCost
    );
    if (stretch) stretch.edges.forEach((edge) => (edge.notes[feature.properties.type] = true));
  }
}

// Problems people report (a blocked ramp, construction...) block every piece
// of path within this many meters of the pin, so Curb Cut routes go around it
const REPORT_METERS = 6;

function markReports(graph, reports) {
  // Start fresh, so a cleared report stops blocking its path
  for (const node of graph.values()) {
    for (const edge of node.edges) delete edge.notes.reported;
  }
  for (const report of reports) {
    const spot = [report.lon, report.lat];
    // Always block the closest path, even if the pin is a little off it
    const nearest = nearestEdge(graph, spot, () => true, 25);
    if (nearest) nearest.edge.notes.reported = true;
    for (const node of graph.values()) {
      for (const edge of node.edges) {
        if (distanceToSegment(spot, node.coord, graph.get(edge.to).coord) < REPORT_METERS) {
          edge.notes.reported = true;
        }
      }
    }
  }
}

// What a piece of path "costs" for the standard route: just its length
function standardCost(edge) {
  return edge.length;
}

// Surfaces that are hard to roll on
const ROUGH_SURFACES = ["gravel", "fine_gravel", "dirt", "ground", "grass", "sand", "mud",
  "woodchips", "unpaved", "cobblestone", "sett", "unhewn_cobblestone", "pebblestone"];

// Kinds of "highway" that are roads or driveways, where you'd walk next to cars
const ROADS = ["service", "residential", "tertiary", "secondary", "primary", "unclassified",
  "living_street", "track"];

// Questions about a piece of path, used by the cost rules below
function isStairs(edge) {
  return edge.properties.highway === "steps" || (edge.notes.barrier && edge.notes.barrier.type === "stairs");
}

function isRough(edge) {
  return edge.notes.rough || ROUGH_SURFACES.includes(edge.properties.surface);
}

function isSteep(edge) {
  const slope = Math.abs(parseFloat(edge.properties.incline)); // e.g. "10%" becomes 10
  return edge.notes.steep || slope > 8;
}

function isCrossing(edge) {
  return edge.properties.footway === "crossing" || Boolean(edge.properties.crossing) || Boolean(edge.notes.crossing);
}

// A spot where 3 or more paths meet, so you have to choose which way to go
function isDecisionPoint(graph, key) {
  return graph.get(key).edges.length >= 3;
}

// What a piece of path "costs" for someone using a wheelchair.
// Infinity means "never use this".
function wheelchairCost(edge) {
  const p = edge.properties;
  if (p.highway === "steps" || p.wheelchair === "no" || edge.notes.barrier) return Infinity;

  let cost = edge.length;
  if (isRough(edge)) cost *= 5;
  if (isSteep(edge)) cost *= 10;
  return cost;
}

// What a piece of path "costs" for someone with low vision.
// Street crossings, walking along roads, and lots of choices make a route
// harder to follow, so they cost extra. Stairs and rough ground are allowed
// but are tripping hazards.
function lowVisionCost(edge, graph) {
  let cost = edge.length;
  if (isCrossing(edge)) cost += 80; // like walking 80 extra meters (crossings are short, so 4× its length was too little)
  if (ROADS.includes(edge.properties.highway)) cost *= 3;
  if (isStairs(edge)) cost *= 2;
  if (isRough(edge)) cost *= 2;
  if (isDecisionPoint(graph, edge.to)) cost += 15; // like walking 15 extra meters
  return cost;
}

// What a piece of path "costs" for someone with limited stamina.
// Stairs and hills are tiring, so they cost extra, but they're allowed.
function staminaCost(edge) {
  let cost = edge.length;
  if (isStairs(edge)) cost *= 4;
  if (isSteep(edge)) cost *= 4;
  if (isRough(edge)) cost *= 2;
  return cost;
}

// Find the cheapest route from one node to another (Dijkstra's algorithm).
// costOfEdge decides what "cheap" means: standardCost, wheelchairCost,
// lowVisionCost or staminaCost.
function findRoute(graph, startKey, endKey, costOfEdge) {
  const bestCost = new Map([[startKey, 0]]);
  const cameFrom = new Map(); // how we reached each node: { from, edge }
  const queue = new PriorityQueue();
  queue.push(startKey, 0);

  while (queue.size() > 0) {
    const { item: current, priority: cost } = queue.pop();
    if (current === endKey) break;
    if (cost > bestCost.get(current)) continue; // already found a cheaper way here

    for (const edge of graph.get(current).edges) {
      const newCost = cost + costOfEdge(edge, graph);
      if (newCost < (bestCost.get(edge.to) ?? Infinity)) {
        bestCost.set(edge.to, newCost);
        cameFrom.set(edge.to, { from: current, edge: edge });
        queue.push(edge.to, newCost);
      }
    }
  }

  if (!bestCost.has(endKey)) return null; // no route exists

  // Walk backward from the end to rebuild the route
  const coords = [graph.get(endKey).coord];
  const edges = [];
  let step = endKey;
  while (step !== startKey) {
    const { from, edge } = cameFrom.get(step);
    edges.unshift(edge);
    coords.unshift(graph.get(from).coord);
    step = from;
  }

  return {
    coords: coords,
    latlngs: coords.map(([lon, lat]) => [lat, lon]), // Leaflet wants latitude first
    edges: edges,
    meters: edges.reduce((total, edge) => total + edge.length, 0),
  };
}

// Count how many separate staircases a route uses (from the map or your walk-through)
// Stairs pieces one right after another along the route are one set
// (like a long row of stairs marked in a few spots)
function countStairs(route) {
  let sets = 0;
  let onStairs = false;
  for (const edge of route.edges) {
    if (isStairs(edge) && !onStairs) sets++;
    onStairs = isStairs(edge);
  }
  return sets;
}

// Does the route go over any rough surface?
function hasRoughStretch(route) {
  return route.edges.some(isRough);
}

// Count how many separate street crossings a route uses
function countCrossings(route) {
  const crossings = new Set();
  for (const edge of route.edges) {
    if (isCrossing(edge)) crossings.add(edge.properties.osm_id);
  }
  return crossings.size;
}

// How many meters of the route are along roads or driveways, beside traffic
function metersOnRoads(route) {
  return route.edges
    .filter((edge) => ROADS.includes(edge.properties.highway))
    .reduce((total, edge) => total + edge.length, 0);
}

// Count the spots along the route (not counting the end) where you have to choose a way
function countDecisionPoints(graph, route) {
  return route.edges.slice(0, -1).filter((edge) => isDecisionPoint(graph, edge.to)).length;
}

// Find the places to rest along a route: benches within 20 m of it.
// Returns each one's spot and how far along the route it is, in order.
function restStopsAlong(route, benches) {
  const NEARBY_METERS = 20;
  const stops = [];
  for (const bench of benches) {
    let best = null;
    let walked = 0; // meters from the start of the route to the current piece
    route.edges.forEach((edge, i) => {
      const spot = closestOnSegment(bench, route.coords[i], route.coords[i + 1]);
      if (spot.meters < NEARBY_METERS && (!best || spot.meters < best.meters)) {
        best = { meters: spot.meters, along: walked + spot.t * edge.length };
      }
      walked += edge.length;
    });
    if (best) stops.push({ coord: bench, along: best.along });
  }
  return stops.sort((a, b) => a.along - b.along);
}

// The longest stretch of the route you'd walk without passing a place to rest
function longestWithoutRest(route, stops) {
  const marks = [0, ...stops.map((stop) => stop.along), route.meters];
  let longest = 0;
  for (let i = 1; i < marks.length; i++) longest = Math.max(longest, marks[i] - marks[i - 1]);
  return longest;
}

// A "priority queue" hands back whichever item has the lowest cost first.
// Dijkstra's algorithm uses it to always explore the closest point next.
class PriorityQueue {
  constructor() {
    this.heap = [];
  }

  size() {
    return this.heap.length;
  }

  push(item, priority) {
    this.heap.push({ item, priority });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      while (true) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.heap.length && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
        if (right < this.heap.length && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
        if (smallest === i) break;
        [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
