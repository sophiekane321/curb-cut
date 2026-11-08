// Curb Cut: the code that runs the map.

// Duke Chapel, roughly the middle of West Campus (latitude, longitude)
const WEST_CAMPUS_CENTER = [36.0019, -78.9403];

// Create the map and zoom in on West Campus
const map = L.map("map").setView(WEST_CAMPUS_CENTER, 17);

// Draw the OpenStreetMap background
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// How each kind of path is drawn
function pathStyle(feature) {
  const kind = feature.properties.highway;
  if (kind === "steps") {
    return { color: "#d7263d", weight: 5, dashArray: "4 4" };
  }
  if (["footway", "path", "pedestrian", "corridor", "cycleway"].includes(kind)) {
    return { color: "#1f6fd1", weight: 3 };
  }
  return { color: "#777777", weight: 2 };
}

// The words shown when you hover over a path
function describePath(properties) {
  const lines = [properties.name || properties.highway];
  if (properties.footway) lines.push("type: " + properties.footway);
  if (properties.surface) lines.push("surface: " + properties.surface);
  if (properties.incline) lines.push("slope: " + properties.incline);
  if (properties.wheelchair) lines.push("wheelchair: " + properties.wheelchair);
  return lines.join("<br>");
}

let pathsLayer = null;
let walkthroughLayer = null;
let graph = null; // the paths, turned into something we can route through
let benches = []; // places to rest from your walk-through, as [longitude, latitude]

document.getElementById("show-paths").addEventListener("change", (event) => {
  if (!pathsLayer) return;
  if (event.target.checked) {
    pathsLayer.addTo(map);
  } else {
    map.removeLayer(pathsLayer);
  }
});

// How each kind of walk-through feature looks: a symbol, a plain-English
// name, and a border color (red = barrier, green = helpful, purple = rest)
const FEATURE_LOOKS = {
  stairs: { symbol: "🪜", name: "Stairs", color: "#d7263d" },
  missing_curb_cut: { symbol: "⛔", name: "Missing curb cut", color: "#d7263d" },
  ramp: { symbol: "♿", name: "Ramp", color: "#1a9850" },
  curb_cut: { symbol: "✅", name: "Curb cut", color: "#1a9850" },
  crossing: { symbol: "🚸", name: "Street crossing", color: "#e08214" },
  elevator: { symbol: "🛗", name: "Elevator", color: "#1a9850" },
  accessible_entrance: { symbol: "🚪", name: "Accessible entrance", color: "#1a9850" },
  bench: { symbol: "🪑", name: "Place to rest", color: "#7b3fa0" },
  other: { symbol: "⚠️", name: "Other", color: "#e08214" },
  rough: { name: "Rough surface", color: "#e08214" },
  steep: { name: "Steep slope", color: "#d7263d" },
  missing_path: { name: "Path not on the map (added from walk-through)", color: "#1a9850" },
};

// The popup that appears when you click a feature: your photo(s) and notes
function featurePopup(properties) {
  const look = FEATURE_LOOKS[properties.type] || { name: properties.type };
  const photos = properties.images
    .filter((image) => image)
    .map((image) => `<img src="${image}" alt="Walk-through photo" class="feature-photo">`)
    .join("");
  return `<strong>${look.name}</strong><br>${properties.notes || ""}<br>${photos}
    <div class="photo-name">${properties.photos.join(", ")}</div>`;
}

// Load the paths (made by download_paths.py) and your walk-through
// (made by import_walkthrough.py), then draw them both
Promise.all([
  fetch("data/paths.geojson").then((response) => response.json()),
  // If there's no walk-through file yet, carry on without one
  fetch("data/walkthrough.geojson")
    .then((response) => response.json())
    .catch(() => ({ type: "FeatureCollection", features: [] })),
]).then(([paths, walkthrough]) => {
  graph = buildGraph(paths);
  applyWalkthrough(graph, walkthrough);
  benches = walkthrough.features
    .filter((feature) => feature.properties.type === "bench")
    .map((feature) => feature.geometry.coordinates);
  markReports(graph, reports);
  drawReports();

  pathsLayer = L.geoJSON(paths, {
    style: pathStyle,
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(describePath(feature.properties), { sticky: true });
    },
  }).addTo(map);

  walkthroughLayer = L.geoJSON(walkthrough, {
    // Points become a round badge with a symbol inside
    pointToLayer: (feature, latlng) => {
      const look = FEATURE_LOOKS[feature.properties.type] || FEATURE_LOOKS.other;
      const icon = L.divIcon({
        className: "feature-icon",
        html: `<span style="border-color: ${look.color}">${look.symbol}</span>`,
        iconSize: [30, 30],
      });
      return L.marker(latlng, { icon: icon, title: look.name });
    },
    // Lines (rough surfaces, slopes, new paths) are thick dashes
    style: (feature) => ({
      color: (FEATURE_LOOKS[feature.properties.type] || FEATURE_LOOKS.other).color,
      weight: 6,
      dashArray: "10 8",
      bubblingMouseEvents: false, // clicking a line shouldn't drop a route pin
    }),
    onEachFeature: (feature, layer) => {
      layer.bindPopup(featurePopup(feature.properties), { maxWidth: 260 });
    },
  }).addTo(map);
});

document.getElementById("show-walkthrough").addEventListener("change", (event) => {
  if (!walkthroughLayer) return;
  if (event.target.checked) {
    walkthroughLayer.addTo(map);
  } else {
    map.removeLayer(walkthroughLayer);
  }
});

// Remember the points the user picks, and the route drawn between them
let startMarker = null;
let endMarker = null;
const routeLayer = L.layerGroup().addTo(map);

const instructions = document.getElementById("instructions");

// Draw a route as a thick line with a white outline so it stands out
function drawRoute(route, color) {
  // Connect the pins to where the route starts and ends on the paths
  const line = [startMarker.getLatLng(), ...route.latlngs, endMarker.getLatLng()];
  L.polyline(line, { color: "white", weight: 10, opacity: 0.9 }).addTo(routeLayer);
  L.polyline(line, { color: color, weight: 6 }).addTo(routeLayer);
}

const SHORTEST_COLOR = "#333333";
const CURB_CUT_COLOR = "#00a19a";
const REST_COLOR = "#7b3fa0";

// Words for a count, like "no stairs", "1 set of stairs", "2 sets of stairs"
function count(n, one, many, none = "no " + many) {
  if (n === 0) return none;
  return n === 1 ? "1 " + one : n + " " + many;
}

function stairsText(route) {
  return count(countStairs(route), "set of stairs", "sets of stairs", "no stairs");
}

// The three kinds of Curb Cut route. Each has a cost rule (from routing.js)
// and the details that matter most for that person.
const PROFILES = {
  wheelchair: {
    name: "Wheelchair",
    cost: wheelchairCost,
    details: (route) => [
      stairsText(route),
      ...(hasRoughStretch(route) ? ["some rough ground"] : []),
    ],
  },
  lowVision: {
    name: "Low vision",
    cost: lowVisionCost,
    details: (route) => {
      const roadMeters = Math.round(metersOnRoads(route));
      return [
        count(countCrossings(route), "street crossing", "street crossings"),
        count(countDecisionPoints(graph, route), "decision point", "decision points"),
        stairsText(route),
        ...(roadMeters > 0 ? [`${roadMeters} m beside traffic`] : []),
      ];
    },
  },
  stamina: {
    name: "Limited stamina",
    cost: staminaCost,
    details: (route) => {
      const stops = restStopsAlong(route, benches);
      return [
        count(stops.length, "place to rest", "places to rest"),
        `longest without a rest: ${Math.round(longestWithoutRest(route, stops))} m`,
      ];
    },
  },
};

let profile = PROFILES.wheelchair; // which kind of route to show

// A one-line summary of a route, like "187 m · about 2 min · 2 sets of stairs"
function describeRoute(route) {
  const minutes = Math.max(1, Math.round(route.meters / 80)); // about 80 m per minute walking
  return [`${Math.round(route.meters)} m`, `about ${minutes} min`, ...profile.details(route)].join(" · ");
}

// Find and show both routes between the two pins:
// the shortest one, and the Curb Cut one for the chosen profile
function showRoutes() {
  routeLayer.clearLayers();
  const start = nearestNode(graph, startMarker.getLatLng());
  const end = nearestNode(graph, endMarker.getLatLng());
  const shortest = findRoute(graph, start, end, standardCost);
  // The Curb Cut route also goes around reported problems
  const avoidReports = (edge, g) => (edge.notes.reported ? Infinity : profile.cost(edge, g));
  const curbCut = findRoute(graph, start, end, avoidReports);

  if (!shortest) {
    instructions.textContent = "Sorry, no route found between those points.";
    return;
  }

  // Fade the paths so the routes stand out
  if (pathsLayer) pathsLayer.setStyle((feature) => ({ ...pathStyle(feature), opacity: 0.3 }));

  drawRoute(shortest, SHORTEST_COLOR);
  let curbCutText;
  if (!curbCut) {
    curbCutText = "no route found for this profile between these points.";
  } else {
    drawRoute(curbCut, CURB_CUT_COLOR); // drawn second so it's on top
    const sameRoute = curbCut.edges.length === shortest.edges.length &&
      curbCut.edges.every((edge, i) => edge === shortest.edges[i]);
    curbCutText = sameRoute
      ? "same as the shortest route."
      : describeRoute(curbCut);

    // For limited stamina, circle the places to rest along the route
    if (profile === PROFILES.stamina) {
      for (const stop of restStopsAlong(curbCut, benches)) {
        const [lon, lat] = stop.coord;
        L.circleMarker([lat, lon], { radius: 22, color: REST_COLOR, weight: 4, fill: false }).addTo(routeLayer);
      }
    }
  }

  const shortestHitsReport = shortest.edges.some((edge) => edge.notes.reported);
  instructions.innerHTML = `
    <span class="route-line"><span class="swatch shortest"></span> <strong>Shortest:</strong> ${describeRoute(shortest)}${shortestHitsReport ? " · ⚠️ goes through a reported problem" : ""}</span>
    <span class="route-line"><span class="swatch curb-cut"></span> <strong>Curb Cut (${profile.name}):</strong> ${curbCutText}</span>`;
}

// The profile buttons: pick who the route is for, and redraw if there's a route
document.querySelectorAll("#profiles button").forEach((button) => {
  button.addEventListener("click", () => {
    profile = PROFILES[button.dataset.profile];
    document.querySelectorAll("#profiles button").forEach((other) => {
      other.setAttribute("aria-pressed", String(other === button));
    });
    if (startMarker && endMarker && graph) showRoutes();
  });
});

// ---- Live reports ----
// Anyone can drop a pin to report a problem. Routes avoid it until someone
// marks it cleared. Reports are saved in this browser only (a shared
// database like Supabase would let everyone see them: a next step).

const REPORT_KINDS = ["Blocked ramp", "Broken elevator", "Construction", "Blocked path", "Other"];
const REPORTS_KEY = "curb-cut-reports";

function loadReports() {
  try {
    return JSON.parse(localStorage.getItem(REPORTS_KEY)) || [];
  } catch {
    return []; // private browsing or nothing saved yet
  }
}

function saveReports() {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
  } catch {
    // Can't save (private browsing): reports still work until the page reloads
  }
}

let reports = loadReports();
let reportMode = false;
const reportsLayer = L.layerGroup().addTo(map);
const reportButton = document.getElementById("report");

// Words that escape < and > so a note can't break the page
function plainText(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// After reports change: re-block paths, redraw the pins, and redo any route
function reportsChanged() {
  saveReports();
  if (graph) markReports(graph, reports);
  drawReports();
  if (startMarker && endMarker && graph) showRoutes();
}

function drawReports() {
  reportsLayer.clearLayers();
  for (const report of reports) {
    const icon = L.divIcon({
      className: "feature-icon",
      html: `<span style="border-color: #e08214">⚠️</span>`,
      iconSize: [30, 30],
    });
    const popup = document.createElement("div");
    const when = new Date(report.time).toLocaleString();
    popup.innerHTML = `<strong>${plainText(report.kind)}</strong><br>${plainText(report.note || "")}
      <div class="report-time">Reported ${when}</div>`;
    const clear = document.createElement("button");
    clear.className = "clear-report";
    clear.textContent = "✓ It's cleared";
    clear.addEventListener("click", () => {
      reports = reports.filter((other) => other.id !== report.id);
      reportsChanged();
    });
    popup.appendChild(clear);
    L.marker([report.lat, report.lon], { icon: icon, title: report.kind })
      .bindPopup(popup)
      .addTo(reportsLayer);
  }
}

function setReportMode(on) {
  reportMode = on;
  reportButton.setAttribute("aria-pressed", String(on));
  if (on) {
    instructions.innerHTML = "Click the map where the <strong>problem</strong> is. (Click ⚠️ again to cancel.)";
  } else if (!startMarker) {
    instructions.innerHTML = "Click the map to choose your <strong>start</strong> point.";
  } else if (!endMarker) {
    instructions.innerHTML = "Now click the map to choose your <strong>end</strong> point.";
  } else {
    showRoutes();
  }
}

reportButton.addEventListener("click", () => setReportMode(!reportMode));

// The little form that pops up where you clicked
function openReportForm(latlng) {
  const form = document.createElement("form");
  form.className = "report-form";
  form.innerHTML = `
    <strong>Report a problem here</strong>
    <label>What's wrong?
      <select name="kind">${REPORT_KINDS.map((kind) => `<option>${kind}</option>`).join("")}</select>
    </label>
    <label>Details (optional)
      <input name="note" maxlength="120" placeholder="e.g. ramp closed for repairs">
    </label>
    <button type="submit">Save report</button>`;
  const popup = L.popup().setLatLng(latlng).setContent(form).openOn(map);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    reports.push({
      id: Date.now(),
      lat: latlng.lat,
      lon: latlng.lng,
      kind: form.kind.value,
      note: form.note.value.trim(),
      time: new Date().toISOString(),
    });
    map.closePopup(popup);
    setReportMode(false);
    reportsChanged();
  });
}

// Each click on the map sets the start point first, then the end point
// (or, while reporting, places the problem)
map.on("click", (event) => {
  if (reportMode) {
    openReportForm(event.latlng);
    return;
  }
  if (!startMarker) {
    startMarker = L.marker(event.latlng).addTo(map).bindPopup("Start").openPopup();
    instructions.innerHTML = "Now click the map to choose your <strong>end</strong> point.";
  } else if (!endMarker) {
    endMarker = L.marker(event.latlng).addTo(map).bindPopup("End").openPopup();
    if (graph) {
      showRoutes();
    } else {
      instructions.textContent = "Still loading the paths. Click Start over and try again in a moment.";
    }
  }
});

// "Start over" removes both markers
document.getElementById("reset").addEventListener("click", () => {
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  startMarker = null;
  endMarker = null;
  routeLayer.clearLayers();
  if (pathsLayer) pathsLayer.setStyle(pathStyle); // un-fade the paths
  reportMode = false;
  reportButton.setAttribute("aria-pressed", "false");
  instructions.innerHTML = "Click the map to choose your <strong>start</strong> point.";
});
