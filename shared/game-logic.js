(function(root) {
// ============================================================================
// CONSTANTS
// ============================================================================

// World coordinate bounds — derived from hex grid (x:15-63, y:6-69),
// landmass extents, and city positions, with padding for visual margin.
var WORLD_BOUNDS = { minX: 12, minY: 1, maxX: 66, maxY: 73 };

var MAJOR_CITIES = ["Amsterdam", "Berlin", "Essen", "London", "Madrid", "Milano", "Paris", "Vienna"];

var CITIES = {
    "Aberdeen": { x: 29.5, y: 13, type: "small", goods: ["Fish", "Oil"], country: "UK" },
    "Glasgow": { x: 27, y: 17, type: "small", goods: ["Sheep"], country: "UK" },
    "Belfast": { x: 22, y: 19, type: "small", goods: ["Potatoes"], country: "UK" },
    "Edinburgh": { x: 29, y: 17.5, type: "small", goods: [], country: "UK" },
    "Newcastle": { x: 30.5, y: 21, type: "small", goods: ["Oil"], country: "UK" },
    "Dublin": { x: 19, y: 24, type: "small", goods: ["Beer"], country: "Ireland" },
    "Manchester": { x: 30, y: 25, type: "medium", goods: ["Cars"], country: "UK" },
    "Birmingham": { x: 30.5, y: 28, type: "medium", goods: ["China", "Iron", "Steel", "Chocolate"], country: "UK" },
    "Cardiff": { x: 28, y: 30, type: "small", goods: ["Coal", "Hops"], country: "UK" },
    "London": { x: 33, y: 30, type: "major", goods: ["Tourists"], country: "UK" },
    "Cork": { x: 17, y: 29, type: "small", goods: ["Cork", "Sheep"], country: "Ireland" },
    "Oslo": { x: 44, y: 8, type: "medium", goods: ["Fish", "Oil", "Wood"], country: "Norway" },
    "Stockholm": { x: 53, y: 9, type: "medium", goods: ["Iron"], country: "Sweden" },
    "Göteborg": { x: 47, y: 13, type: "medium", goods: ["Machinery"], country: "Sweden" },
    "København": { x: 48, y: 19, type: "medium", goods: ["Cheese"], country: "Denmark" },
    "Århus": { x: 45.5, y: 17, type: "small", goods: ["Cheese"], country: "Denmark" },
    "Amsterdam": { x: 38, y: 27, type: "major", goods: ["Flowers", "Cheese"], country: "Netherlands" },
    "Antwerpen": { x: 38.5, y: 30, type: "medium", goods: ["Imports"], country: "Belgium" },
    "Bruxelles": { x: 38, y: 32, type: "medium", goods: ["Chocolate"], country: "Belgium" },
    "Luxembourg": { x: 40, y: 35, type: "small", goods: ["Steel"], country: "Luxembourg" },
    "Hamburg": { x: 44, y: 22, type: "medium", goods: ["Imports"], country: "Germany" },
    "Bremen": { x: 43, y: 24, type: "medium", goods: ["Machinery"], country: "Germany" },
    "Essen": { x: 41, y: 28, type: "major", goods: ["Steel", "Tourists"], country: "Germany" },
    "Berlin": { x: 50.5, y: 24, type: "major", goods: [], country: "Germany" },
    "Leipzig": { x: 49, y: 28, type: "medium", goods: ["China"], country: "Germany" },
    "Frankfurt": { x: 43, y: 32, type: "medium", goods: ["Beer", "Wine"], country: "Germany" },
    "Stuttgart": { x: 44, y: 36, type: "medium", goods: ["Cars"], country: "Germany" },
    "München": { x: 47, y: 38, type: "medium", goods: ["Beer", "Cars"], country: "Germany" },
    "Szczecin": { x: 52, y: 22, type: "small", goods: ["Potatoes"], country: "Poland" },
    "Warszawa": { x: 58, y: 26, type: "medium", goods: ["Ham"], country: "Poland" },
    "Lodz": { x: 57, y: 28, type: "small", goods: ["Potatoes"], country: "Poland" },
    "Wroclaw": { x: 54, y: 30, type: "medium", goods: ["Coal", "Copper"], country: "Poland" },
    "Krakow": { x: 57, y: 33, type: "medium", goods: ["Coal"], country: "Poland" },
    "Kaliningrad": { x: 58, y: 19, type: "small", goods: ["Iron"], country: "Russia" },
    "Paris": { x: 35, y: 37, type: "major", goods: [], country: "France" },
    "Nantes": { x: 28, y: 39, type: "medium", goods: ["Cattle", "Machinery"], country: "France" },
    "Bordeaux": { x: 30, y: 46, type: "medium", goods: ["Wine"], country: "France" },
    "Toulouse": { x: 33, y: 50, type: "medium", goods: ["Wheat"], country: "France" },
    "Lyon": { x: 38.5, y: 44, type: "medium", goods: ["Wheat"], country: "France" },
    "Marseille": { x: 38, y: 51, type: "medium", goods: ["Bauxite"], country: "France" },
    "Bilbao": { x: 27, y: 50, type: "small", goods: ["Sheep"], country: "Spain" },
    "Porto": { x: 19, y: 54, type: "medium", goods: ["Fish", "Wine", "Cork"], country: "Portugal" },
    "Madrid": { x: 24, y: 58, type: "major", goods: [], country: "Spain" },
    "Lisboa": { x: 17, y: 61, type: "medium", goods: ["Cork"], country: "Portugal" },
    "Sevilla": { x: 21, y: 66, type: "medium", goods: ["Cork", "Oranges"], country: "Spain" },
    "Valencia": { x: 28, y: 62, type: "medium", goods: ["Oranges"], country: "Spain" },
    "Barcelona": { x: 33, y: 56, type: "medium", goods: ["Machinery"], country: "Spain" },
    "Bern": { x: 41, y: 39, type: "medium", goods: ["Cattle", "Cheese"], country: "Switzerland" },
    "Zürich": { x: 43, y: 38, type: "medium", goods: ["Chocolate"], country: "Switzerland" },
    "Vienna": { x: 53, y: 36, type: "major", goods: ["Wine"], country: "Austria" },
    "Milano": { x: 43.5, y: 43, type: "major", goods: [], country: "Italy" },
    "Torino": { x: 41, y: 44, type: "medium", goods: ["Cars"], country: "Italy" },
    "Venezia": { x: 48, y: 43, type: "medium", goods: [], country: "Italy" },
    "Firenze": { x: 46, y: 48, type: "medium", goods: ["Marble"], country: "Italy" },
    "Roma": { x: 48, y: 54, type: "medium", goods: [], country: "Italy" },
    "Napoli": { x: 51, y: 58, type: "medium", goods: ["Tobacco"], country: "Italy" },
    "Zagreb": { x: 53, y: 42, type: "medium", goods: ["Labor"], country: "Croatia" },
    "Budapest": { x: 57, y: 38, type: "medium", goods: ["Bauxite"], country: "Hungary" },
    "Sarajevo": { x: 56, y: 47, type: "small", goods: ["Labor", "Wood"], country: "Bosnia" },
    "Beograd": { x: 59, y: 44, type: "medium", goods: ["Copper", "Labor", "Oil"], country: "Serbia" },
    "Praha": { x: 51, y: 31, type: "medium", goods: ["Beer"], country: "Czech" }
};

var GOODS = {
    "Bauxite": { chips: 3, sources: ["Budapest", "Marseille"] },
    "Beer": { chips: 4, sources: ["Dublin", "Frankfurt", "München", "Praha"] },
    "Cars": { chips: 3, sources: ["Manchester", "München", "Stuttgart", "Torino"] },
    "Cattle": { chips: 3, sources: ["Bern", "Nantes"] },
    "Cheese": { chips: 4, sources: ["Århus", "Bern", "Amsterdam", "København"] },
    "China": { chips: 3, sources: ["Birmingham", "Leipzig"] },
    "Chocolate": { chips: 3, sources: ["Bruxelles", "Zürich"] },
    "Coal": { chips: 3, sources: ["Cardiff", "Krakow", "Wroclaw"] },
    "Copper": { chips: 3, sources: ["Beograd", "Wroclaw"] },
    "Cork": { chips: 3, sources: ["Cork", "Lisboa", "Sevilla"] },
    "Fish": { chips: 3, sources: ["Aberdeen", "Oslo", "Porto"] },
    "Flowers": { chips: 3, sources: ["Amsterdam"] },
    "Ham": { chips: 3, sources: ["Warszawa"] },
    "Hops": { chips: 3, sources: ["Cardiff"] },
    "Imports": { chips: 3, sources: ["Antwerpen", "Hamburg"] },
    "Iron": { chips: 3, sources: ["Birmingham", "Kaliningrad", "Stockholm"] },
    "Labor": { chips: 3, sources: ["Beograd", "Sarajevo", "Zagreb"] },
    "Machinery": { chips: 4, sources: ["Barcelona", "Bremen", "Göteborg", "Nantes"] },
    "Marble": { chips: 3, sources: ["Firenze"] },
    "Oil": { chips: 4, sources: ["Aberdeen", "Beograd", "Newcastle", "Oslo"] },
    "Oranges": { chips: 3, sources: ["Sevilla", "Valencia"] },
    "Potatoes": { chips: 3, sources: ["Belfast", "Lodz", "Szczecin"] },
    "Sheep": { chips: 3, sources: ["Bilbao", "Cork", "Glasgow"] },
    "Steel": { chips: 3, sources: ["Birmingham", "Luxembourg", "Essen"] },
    "Tobacco": { chips: 3, sources: ["Napoli"] },
    "Tourists": { chips: 3, sources: ["London", "Essen"] },
    "Wheat": { chips: 3, sources: ["Lyon", "Toulouse"] },
    "Wine": { chips: 4, sources: ["Bordeaux", "Frankfurt", "Porto", "Vienna"] },
    "Wood": { chips: 3, sources: ["Oslo", "Sarajevo"] }
};

var SPEED_TIERS = {
    "Standard":  { slow: 9,  fast: 12 },
    "Faster":    { slow: 12, fast: 16 },
    "Fastest":   { slow: 15, fast: 20 }
};

var TRAIN_TYPES = {
    "Freight":       { category: "slow", capacity: 2 },
    "Fast Freight":  { category: "fast", capacity: 2 },
    "Heavy Freight": { category: "slow", capacity: 3 },
    "Superfreight":  { category: "fast", capacity: 3 }
};

function getTrainMovement(trainType, speedTier) {
    var tier = SPEED_TIERS[speedTier] || SPEED_TIERS["Standard"];
    var cat = TRAIN_TYPES[trainType].category;
    return tier[cat];
}

var EVENT_TYPES = {
    "Derailment": "Lose 1 turn and 1 load",
    "Snow": "Move at half speed next turn",
    "Strike": "Can't move or build this turn",
    "Flood": "Some connections unusable",
    "Tax": "Pay tax based on cash"
};

var COLOR_MAP = {
    "red": "#ff0000",
    "blue": "#0066ff",
    "green": "#009900",
    "yellow": "#ffcc00",
    "purple": "#cc00ff",
    "orange": "#ff8800"
};

// Landmass polygons — traced from the actual Eurorails game board image
var LANDMASSES = {
    britain: [
        [23.3,32.9],[24.5,32.9],[25.9,32.3],[27.1,32.7],[28.2,32.0],
        [29.2,32.0],[30.0,31.9],[31.1,31.9],[31.3,31.9],[31.8,31.8],
        [32.2,31.7],[32.6,31.6],[32.7,31.5],[32.9,31.1],[33.0,30.6],
        [33.0,30.2],[33.1,29.3],[33.2,28.4],[33.1,28.3],[33.3,27.6],
        [33.8,26.5],[33.8,26.2],[33.7,25.5],[33.0,25.9],[32.8,26.3],
        [32.7,25.9],[32.8,25.2],[32.7,24.7],[32.5,24.6],[32.5,24.2],
        [32.3,23.2],[32.1,22.3],[31.3,22.1],[31.0,21.6],[30.7,20.9],
        [30.5,20.1],[30.4,19.0],[30.2,18.3],[29.9,17.5],[29.6,17.2],
        [29.4,16.7],[29.6,16.2],[29.4,15.7],[29.3,15.4],[29.4,14.7],
        [29.6,14.5],[29.6,13.4],[29.7,11.8],[29.4,11.2],[28.3,11.1],
        [27.7,10.6],[27.8,10.0],[27.9,8.7],[28.0,8.0],[27.5,8.0],
        [26.4,8.0],[25.2,7.6],[25.3,8.3],[25.0,8.6],[25.2,9.7],
        [24.5,9.7],[24.3,10.4],[23.9,11.1],[24.1,11.4],[24.5,12.2],
        [23.8,12.9],[22.9,12.7],[23.7,13.4],[24.0,13.7],[24.4,14.0],
        [24.8,14.7],[25.2,15.3],[25.4,15.9],[25.7,16.3],[25.3,17.0],
        [25.5,17.5],[25.0,17.9],[25.0,19.3],[25.3,20.1],[27.5,20.3],
        [28.3,20.7],[28.6,21.2],[27.8,21.8],[28.3,22.7],[28.9,23.1],
        [28.5,23.7],[28.5,24.4],[28.3,24.9],[28.2,25.2],[27.3,25.1],
        [26.0,24.9],[24.8,24.6],[24.4,24.2],[25.2,24.6],[25.7,25.0],
        [24.4,25.6],[23.6,25.9],[24.0,26.4],[25.6,27.3],[25.8,28.2],
        [24.9,28.7],[23.7,29.0],[22.6,29.0],[22.8,29.2],[23.6,29.3],
        [25.3,29.4],[26.4,29.6],[27.2,30.0],[27.7,30.2],[28.4,30.5],
        [28.9,30.8],[28.1,30.7],[27.1,30.6],[25.7,30.6],[24.9,30.7],
        [25.0,31.0],[24.6,31.5],[24.3,31.8],[24.2,32.2],[23.6,32.5],
        [23.3,32.9],
    ],
    ireland: [
        [19.5,24.0],[19.8,24.7],[19.6,25.7],[19.6,26.4],[19.6,27.1],
        [19.5,27.8],[18.6,28.0],[18.4,28.2],[18.0,28.7],[17.8,29.2],
        [17.3,29.4],[15.9,29.7],[15.4,29.2],[14.8,28.7],[14.9,28.1],
        [15.3,28.0],[15.0,26.8],[15.3,26.3],[15.0,25.3],[15.3,24.9],
        [14.8,24.5],[14.6,24.0],[14.7,23.5],[14.7,22.6],[14.9,21.9],
        [15.3,21.2],[16.5,20.8],[16.8,20.2],[17.4,18.9],[18.9,17.6],
        [19.4,16.7],[20.1,17.0],[20.5,17.2],[22.0,17.1],[22.6,17.2],
        [22.7,18.8],[22.6,20.0],[22.0,20.8],[20.5,21.4],[19.9,22.5],
        [19.5,23.2],[19.5,24.0],
    ],
    scandinavia: [
        [40.2,12.3],[41.3,12.2],[42.3,12.1],[42.8,11.0],[43.2,10.3],
        [43.7,9.9],[44.1,9.2],[44.0,8.0],[44.8,9.4],[45.2,10.0],
        [46.1,11.3],[46.8,13.0],[47.1,13.6],[47.8,16.2],[48.6,18.8],
        [49.5,19.1],[50.5,18.6],[51.1,17.3],[51.9,16.7],[52.4,15.9],
        [52.7,14.7],[52.6,13.5],[52.4,12.3],[52.3,11.1],[52.9,9.1],
        [53.2,9.0],[53.2,8.8],[53.7,8.4],[54.4,8.7],[54.1,7.5],
        [53.7,6.6],[52.9,6.0],[50.9,5.1],[47.4,5.2],[43.4,4.0],
        [40.2,4.8],[38.6,5.7],[37.4,5.9],[37.1,5.6],[36.9,6.6],
        [37.6,8.1],[38.2,9.5],[39.0,10.9],[40.2,12.3],
    ],
    denmark: [
        [45.4,13.1],[45.1,13.8],[45.1,14.8],[45.4,15.7],[45.7,16.9],
        [45.8,17.6],[44.7,18.3],[44.0,18.7],[43.3,19.8],[42.9,19.6],
        [42.3,19.3],[42.2,18.4],[42.2,17.2],[42.2,16.0],[42.3,15.3],
        [42.9,14.6],[44.2,13.9],[44.6,13.5],[45.4,13.1],
    ],
    zealand: [
        [46.5,17.6],[46.6,18.2],[47.3,18.9],[47.8,19.3],[48.1,19.5],
        [48.6,18.9],[48.1,18.2],[47.9,17.9],[47.3,17.6],[46.8,17.5],
        [46.5,17.6],
    ],
    continental: [
        [24.9,36.4],[25.3,36.5],[26.6,35.8],[27.2,35.9],[28.0,35.9],
        [28.6,35.9],[29.1,35.9],[29.1,35.0],[29.3,34.2],[29.7,34.0],
        [30.4,34.0],[30.6,34.6],[31.3,34.8],[31.9,34.7],[32.0,34.6],
        [32.3,34.0],[32.7,33.6],[33.1,33.3],[33.4,33.1],[33.5,31.9],
        [33.4,31.0],[33.5,30.4],[34.8,30.4],[35.7,29.9],[36.4,29.7],
        [36.8,29.5],[37.2,28.5],[37.5,27.9],[37.4,27.3],[37.4,26.6],
        [37.4,26.1],[37.6,25.4],[37.6,24.9],[38.1,24.4],[38.9,23.9],
        [39.6,23.4],[40.5,23.0],[41.0,22.8],[41.7,22.4],[42.2,22.2],
        [42.6,21.9],[42.9,21.9],[43.1,21.9],[43.0,21.4],[42.7,21.0],
        [43.0,20.4],[42.9,19.8],[44.5,19.5],[44.8,20.1],[45.0,20.3],
        [45.1,20.4],[45.5,20.5],[45.8,21.1],[46.5,21.1],[47.5,21.2],
        [48.2,21.2],[49.2,20.9],[50.0,20.6],[50.8,20.6],[51.7,21.1],
        [52.2,21.2],[52.9,20.7],[53.6,20.2],[54.2,20.2],[54.9,19.8],
        [55.4,19.6],[56.0,19.4],[56.3,20.3],[56.6,20.3],[57.1,20.0],
        [57.4,19.7],[57.8,19.1],[58.0,18.8],[58.4,18.7],[58.5,18.9],
        [58.8,19.9],[60.1,20.6],[60.6,23.2],[60.9,26.0],[61.3,28.7],
        [61.5,31.3],[60.1,34.4],[59.8,35.7],[59.6,38.0],[59.4,40.1],
        [60.2,42.4],[60.9,44.9],[61.5,46.3],[60.9,47.6],[60.3,50.6],
        [59.7,52.1],[58.4,53.9],[58.1,55.5],[57.8,57.2],[57.7,58.9],
        [57.8,59.5],[57.6,60.2],[57.3,59.0],[56.7,53.3],[56.4,52.1],
        [56.3,51.3],[55.7,50.9],[55.1,50.7],[54.6,50.0],[54.1,49.5],
        [53.6,49.0],[53.1,48.6],[52.4,48.6],[52.0,47.7],[51.6,46.8],
        [51.0,46.3],[51.5,45.1],[51.0,44.6],[50.7,43.8],[50.6,43.4],
        [50.2,42.9],[49.9,42.6],[50.0,42.3],[49.9,42.5],[49.3,42.7],
        [48.6,42.9],[48.2,43.0],[47.9,43.1],[48.0,43.2],[47.9,44.6],
        [48.1,45.3],[48.2,46.8],[45.8,45.8],[44.4,45.8],[43.2,46.1],
        [42.5,46.1],[42.4,46.2],[42.1,46.3],[41.8,46.4],[40.7,48.0],
        [40.4,48.6],[40.0,49.2],[39.4,49.9],[39.0,50.2],[38.5,50.9],
        [38.1,51.3],[38.5,51.4],[38.0,51.1],[37.6,50.9],[37.2,50.9],
        [36.8,50.8],[36.2,50.8],[35.8,51.1],[35.0,51.8],[34.7,51.8],
        [34.2,52.2],[35.1,53.7],[34.0,53.2],[33.1,53.0],[32.6,53.1],[31.8,53.5],
        [31.1,53.2],[30.2,54.0],[29.3,50.2],
        [28.7,49.8],[29.2,48.8],[29.2,47.7],[29.3,46.5],[29.1,45.5],
        [29.1,44.5],[29.0,43.7],[28.8,43.0],[28.8,42.4],[28.7,41.9],
        [28.4,41.8],[28.5,41.4],[27.8,40.8],[27.5,40.3],[27.4,39.5],
        [27.3,39.0],[27.2,38.8],[26.8,38.8],[26.5,38.7],[26.3,38.2],
        [26.1,37.9],[25.9,37.7],[25.6,37.6],[25.2,37.1],[25.0,36.8],
        [24.9,36.4],
    ],
    italy: [
        [42.1,46.3],[43.2,46.1],[44.0,47.0],[44.1,47.6],[44.3,47.9],
        [44.4,48.6],[44.6,48.9],[44.7,49.5],[44.8,50.4],[44.9,51.1],
        [45.7,52.0],[45.8,52.6],[46.7,53.3],[47.5,54.3],[47.7,55.0],
        [48.2,55.4],[48.9,56.2],[49.7,56.5],[50.4,57.4],[50.7,57.8],
        [51.0,58.0],[51.3,58.6],[51.8,59.1],[51.9,58.7],[52.2,59.3],
        [52.3,59.9],[52.6,60.5],[52.8,61.4],[53.0,62.3],[53.1,63.2],
        [52.9,64.0],[52.7,65.8],[52.8,66.5],[53.3,66.7],[53.7,66.0],
        [54.0,64.7],[54.1,63.8],[54.4,62.8],[54.7,61.5],[54.8,60.3],
        [55.7,59.5],[56.2,59.0],[56.4,59.9],[56.5,59.1],[56.5,58.6],
        [56.4,57.8],[55.7,57.4],[54.7,56.6],[54.3,56.4],[53.8,55.9],
        [53.4,55.5],[53.1,55.1],[53.4,54.2],[53.5,54.0],[53.1,54.1],
        [52.5,54.5],[51.9,53.9],[51.2,53.4],[50.7,52.4],[50.1,50.6],
        [49.7,49.5],[49.6,48.5],[49.1,47.8],[48.4,46.8],[48.1,46.2],
        [47.9,44.6],[48.2,44.2],[47.9,43.6],[47.9,43.1],[45.9,45.0],
        [44.4,45.8],[43.2,46.1],[42.1,46.3],
    ],
    iberia: [
        [32.6,53.1],[31.8,53.5],[31.1,53.2],[30.2,54.0],[29.3,50.2],
        [28.7,49.8],[28.1,49.8],[27.5,49.8],[26.9,49.5],[26.3,49.4],
        [25.9,49.3],[25.0,48.7],[23.9,48.7],[23.3,48.4],[22.3,48.6],
        [21.5,48.0],[20.7,47.7],[20.1,48.5],[18.9,49.3],[18.4,49.5],
        [18.9,50.7],[19.0,51.5],[19.0,52.3],[19.0,53.1],[18.9,54.0],
        [18.5,55.2],[18.1,56.7],[17.9,58.1],[17.0,58.9],[16.6,60.4],
        [16.8,61.6],[17.2,62.6],[17.4,65.7],[18.2,66.4],[18.9,66.6],
        [19.1,66.0],[20.2,67.6],[20.9,69.9],[21.4,69.9],[22.1,69.1],
        [22.6,68.7],[23.2,68.9],[24.4,69.0],[25.1,69.1],[25.4,69.5],
        [25.8,68.9],[26.7,67.3],[27.1,66.8],[27.5,65.7],[27.8,64.9],
        [28.0,62.5],[28.2,61.6],[28.8,60.7],[29.0,59.8],[29.8,58.8],
        [30.5,58.2],[31.2,57.2],[31.8,56.9],[32.7,56.3],[33.0,56.0],
        [33.4,56.3],[34.1,56.4],[34.8,55.9],[35.1,55.1],[35.2,54.3],
        [35.1,53.7],[34.0,53.2],[33.1,53.0],[32.6,53.1],
    ],
    sicily: [
        [52.7,66.0],[52.2,65.9],[51.9,66.4],[51.1,66.5],[50.4,66.7],
        [49.6,66.5],[48.8,66.8],[48.0,66.9],[47.8,67.4],[48.1,68.3],
        [48.7,68.9],[49.5,69.5],[50.5,69.7],[51.7,69.6],[52.0,69.3],
        [51.9,68.1],[52.1,67.2],[52.6,66.6],[52.7,66.0],
    ],
    corsica: [
        [43.2,50.5],[43.3,51.1],[43.2,52.1],[43.1,53.1],[42.8,53.8],
        [42.4,55.1],[42.1,55.8],[41.8,55.6],[41.8,55.0],[42.0,54.0],
        [42.2,53.2],[42.4,52.2],[42.5,51.5],[42.7,50.8],[42.9,50.5],
        [43.2,50.5],
    ],
    sardinia: [
        [43.3,56.3],[43.6,56.6],[43.5,57.6],[43.6,58.6],[43.4,59.9],
        [43.3,60.9],[43.1,62.5],[42.6,63.1],[42.0,63.4],[41.3,63.6],
        [41.2,63.1],[41.1,61.9],[41.2,60.6],[41.4,59.7],[41.6,58.7],
        [41.8,57.7],[41.9,57.1],[42.2,56.7],[42.7,56.4],[43.3,56.3],
    ],
};

// Terrain regions
// Mountain pass corridors through the Alps — each is a center-line with a radius.
// Points within the radius get friendlier terrain (mostly clear/mountain, no alpine).
// Based on historical Alpine passes: Mont Cenis (west), Gotthard (central), Brenner (east).
var MOUNTAIN_PASSES = [
    { from: [39.5, 37], to: [41, 44], radius: 1.3 },   // Mont Cenis — France to Torino
    { from: [44, 35.5], to: [43.5, 43], radius: 1.3 },  // Gotthard — Switzerland to Milano
    { from: [49, 36], to: [48.5, 43], radius: 1.3 },    // Brenner — Austria to Venezia
    { from: [33, 49], to: [33, 55], radius: 1.3 }       // Eastern Pyrenees — Toulouse to Barcelona
];

var TERRAIN_REGIONS = {
    alpine: [
        [[39,37], [45,35], [49,36], [53,36], [55,38], [53,41], [50,43], [48,44], [44,48], [39,48], [37,44], [39,37]],
        [[21,47], [35,48], [36,52], [34,54], [20,51], [19,49], [21,47]]  // Pyrenees
    ],
    mountain: [
        [[19,49], [27,48], [28,52], [22,53], [20,56], [18,55], [18,52], [19,49]],  // Cantabrian Mountains (northern Spain coast to Porto)
        [[27,11], [31,11], [32,15], [30,17], [27,15], [27,11]],
        [[38,4], [43,4], [45,7], [43,11], [41,10], [39,7], [38,4]],
        [[49,29], [53,28], [54,31], [53,34], [50,34], [49,31], [49,29]],  // Central Europe (shrunk around Praha)
        [[54,29], [58,27], [61,31], [61,38], [59,40], [57,38], [55,34], [54,29]],
        [[54,43], [58,44], [60,48], [57,51], [54,49], [53,45], [54,43]],
        [[44,47], [47,49], [49,53], [51,57], [49,59], [47,55], [45,51], [44,47]],
        [[27,55], [31,56], [30,60], [27,63], [25,62], [26,58], [27,55]]  // Iberian interior (east of Madrid)
    ]
};

// Rivers as sequences of coordinates
var RIVERS = {
    rhine: [[43,38], [42,36], [41,33], [41,30], [40,28], [39,27]],
    danube: [[48,38], [51,37], [53,36], [55,37], [57,38], [59,42], [60,44]],
    loire: [[35,38], [32,39], [29,39], [27.5,40]],
    elbe: [[50,24], [48,26], [46,24], [44,23]],
    vistula: [[56,20], [57,24], [58,26], [58,30]],
    po: [[42,44], [44,43], [46,43], [48,43]],
    rhone: [[39,43], [38,46], [38,50]],
    seine: [[33,35], [35,37]],
    garonne: [[29.5,47], [31,48], [33,50]],
    douro: [[19,54], [20,54], [22,55]]
};

// Ferry routes (dashed lines across water)
var FERRY_ROUTES = [
    { from: [33.2, 30], to: [34.5, 30], name: "Dover-Calais", cost: 4 },
    { from: [33, 28.5], to: [37, 27], name: "London-Amsterdam", cost: 4 },
    { from: [27, 33], to: [26, 35.5], name: "Plymouth-Brest", cost: 4 },
    { from: [30.5, 21], to: [42, 17], name: "Newcastle-Århus", cost: 14 },
    { from: [45.5, 20.5], to: [47, 19], name: "Germany-Copenhagen", cost: 4 },
    { from: [44.5, 13.5], to: [41, 12], name: "Denmark-Scandinavia", cost: 4 },
    { from: [24.5, 19], to: [23, 19], name: "Scotland-Belfast", cost: 4 },
    { from: [20, 25], to: [25, 27], name: "Dublin-Wales", cost: 6 }
];

// ============================================================================
// SEA AREAS — reference points (world coords) used by gale events
// ============================================================================
var SEA_AREAS = {
    "North Sea":       [{ x: 32, y: 18 }],
    "English Channel": [{ x: 27, y: 32 }],
    "Irish Sea":       [{ x: 23, y: 22 }],
    "Bay of Biscay":   [{ x: 19, y: 48 }],
    "Baltic Sea":      [{ x: 52, y: 17 }],
    "Mediterranean":   [{ x: 34, y: 58 }, { x: 28, y: 72 }, { x: 45, y: 68 }, { x: 59, y: 55 }],
    "Black Sea":       [{ x: 65, y: 28 }, { x: 65, y: 36 }, { x: 65, y: 44 }],
    "Norwegian Sea":   [{ x: 22, y: 6 }],
    "Atlantic":        [
        { x: 13, y: 17 },  // NW of Ireland
        { x: 13, y: 21 },  // W of Ireland (north)
        { x: 13, y: 25 },  // W of Ireland (middle)
        { x: 13, y: 29 },  // SW of Ireland
        { x: 22, y: 34 },  // Off southwest Britain
        { x: 23, y: 37 },  // Off Brittany/Brest
        { x: 25, y: 41 },  // Off western France
        { x: 26, y: 45 },  // Off southwestern France
        { x: 16, y: 50 },  // Off NW Iberia/Galicia
        { x: 16, y: 54 },  // Off northern Portugal
        { x: 15, y: 57 },  // Off central Portugal
        { x: 14, y: 61 },  // Off Lisbon/southern Portugal
        { x: 15, y: 65 },  // Off SW Spain/Algarve
    ]
};

// ============================================================================
// EVENT CARDS (20 total, numbered 121-140)
// ============================================================================

var EVENT_CARDS = [
    // Strikes (121-123)
    {
        id: 121,
        type: "strike",
        title: "Strike! Coast Restriction",
        description: "No train may pick up or deliver any load to any city more than 3 mileposts from any coast.",
        effect: "coastal",
        radius: 3,
        persistent: true
    },
    {
        id: 122,
        type: "strike",
        title: "Strike! Coastal Blockade",
        description: "No train may pick up or deliver any load at any city within 2 mileposts of any coast.",
        effect: "coastal_close",
        radius: 2,
        persistent: true
    },
    {
        id: 123,
        type: "strike",
        title: "Strike! Rail Closure",
        description: "No train may move on the drawing player's rail lines. Drawing player may not build track.",
        effect: "player_strike",
        persistent: true
    },
    // Tax (124)
    {
        id: 124,
        type: "tax",
        title: "Excess Profit Tax!",
        description: "All players pay tax based on cash on hand: 0-50M=0, 51-100M=10M, 101-150M=15M, 151-200M=20M, 201+=25M",
        persistent: false
    },
    // Derailments (125-129)
    {
        id: 125,
        type: "derailment",
        title: "Derailment! Milano/Roma",
        description: "All trains within 3 mileposts of Milano/Roma lose 1 turn and 1 load.",
        cities: ["Milano", "Roma"],
        radius: 3,
        persistent: false
    },
    {
        id: 126,
        type: "derailment",
        title: "Derailment! London/Birmingham",
        description: "All trains within 2 mileposts of London/Birmingham lose 1 turn and 1 load.",
        cities: ["London", "Birmingham"],
        radius: 2,
        persistent: false
    },
    {
        id: 127,
        type: "derailment",
        title: "Derailment! Paris/Marseille",
        description: "All trains within 3 mileposts of Paris/Marseille lose 1 turn and 1 load.",
        cities: ["Paris", "Marseille"],
        radius: 3,
        persistent: false
    },
    {
        id: 128,
        type: "derailment",
        title: "Derailment! Berlin/Hamburg",
        description: "All trains within 3 mileposts of Berlin/Hamburg lose 1 turn and 1 load.",
        cities: ["Berlin", "Hamburg"],
        radius: 3,
        persistent: false
    },
    {
        id: 129,
        type: "derailment",
        title: "Derailment! Madrid/Barcelona",
        description: "All trains within 3 mileposts of Madrid/Barcelona lose 1 turn and 1 load.",
        cities: ["Madrid", "Barcelona"],
        radius: 3,
        persistent: false
    },
    // Snow (130-133)
    {
        id: 130,
        type: "snow",
        title: "Snow! Torino",
        description: "All trains within 6 mileposts of Torino move at half rate. No movement or railbuilding allowed in alpine mileposts of area.",
        city: "Torino",
        radius: 6,
        blockedTerrain: ["alpine"],
        persistent: true
    },
    {
        id: 131,
        type: "snow",
        title: "Snow! München",
        description: "All trains within 5 mileposts of München move at half rate. No movement or railbuilding allowed in mountain mileposts of area.",
        city: "München",
        radius: 5,
        blockedTerrain: ["mountain"],
        persistent: true
    },
    {
        id: 132,
        type: "snow",
        title: "Snow! Praha",
        description: "All trains within 4 mileposts of Praha move at half rate. No movement or railbuilding allowed in mountain mileposts of area.",
        city: "Praha",
        radius: 4,
        blockedTerrain: ["mountain"],
        persistent: true
    },
    {
        id: 133,
        type: "snow",
        title: "Snow! Krakow",
        description: "All trains within 6 mileposts of Krakow move at half rate. No movement or railbuilding allowed in mountain mileposts of area.",
        city: "Krakow",
        radius: 6,
        blockedTerrain: ["mountain"],
        persistent: true
    },
    // Fog (134)
    {
        id: 134,
        type: "fog",
        title: "Fog! Frankfurt",
        description: "All trains within 4 mileposts of Frankfurt move at half rate. No railbuilding allowed in this area.",
        city: "Frankfurt",
        radius: 4,
        persistent: true
    },
    // Floods (135-137)
    {
        id: 135,
        type: "flood",
        title: "Flood! Rhine River",
        description: "No train may cross the Rhine River. All rail lines over this river are destroyed, but may be rebuilt.",
        river: "rhine",
        persistent: false
    },
    {
        id: 136,
        type: "flood",
        title: "Flood! Danube River",
        description: "No train may cross the Danube River. All rail lines over this river are destroyed, but may be rebuilt.",
        river: "danube",
        persistent: false
    },
    {
        id: 137,
        type: "flood",
        title: "Flood! Loire River",
        description: "No train may cross the Loire River. All rail lines over this river are destroyed, but may be rebuilt.",
        river: "loire",
        persistent: false
    },
    // Gales (138-140)
    {
        id: 138,
        type: "gale",
        title: "Gale! North Sea & English Channel",
        description: "All trains within 6 mileposts of the North Sea or English Channel move at half rate. No railbuilding, ferry building, or ferry movement allowed. Trains at ferry ports in this area are derailed (lose 1 turn and 1 load).",
        seaAreas: ["North Sea", "English Channel"],
        radius: 6,
        persistent: true
    },
    {
        id: 139,
        type: "gale",
        title: "Gale! Baltic & Mediterranean",
        description: "All trains within 4 mileposts of the Baltic Sea or Mediterranean move at half rate. No railbuilding or ferry building allowed in this area.",
        seaAreas: ["Baltic Sea", "Mediterranean"],
        radius: 4,
        persistent: true
    },
    {
        id: 140,
        type: "gale",
        title: "Gale! Atlantic & Bay of Biscay",
        description: "All trains within 4 mileposts of the Atlantic or Bay of Biscay move at half rate. No railbuilding or ferry building allowed in this area.",
        seaAreas: ["Atlantic", "Bay of Biscay"],
        radius: 4,
        persistent: true
    }
];

var GOODS_ICONS = {
    "Bauxite": "🧱", "Beer": "🍺", "Cars": "🚗", "Cattle": "🐄",
    "Cheese": "🧀", "China": "🏺", "Chocolate": "🍫", "Coal": "⛏",
    "Copper": "🔶", "Cork": "🍾", "Fish": "🐟", "Flowers": "🌷",
    "Ham": "🍖", "Hops": "🌿", "Imports": "📦", "Iron": "⚙",
    "Labor": "👷", "Machinery": "🔧", "Marble": "🏛", "Oil": "🛢",
    "Oranges": "🍊", "Potatoes": "🥔", "Sheep": "🐑", "Steel": "🗼",
    "Tobacco": "🚬", "Tourists": "🎭", "Wheat": "🌾", "Wine": "🍷",
    "Wood": "🪵"
};

// ============================================================================
// GEOMETRY AND HEX GRID UTILITIES
// ============================================================================

function pointInPolygon(point, polygon) {
    var x = point[0], y = point[1];
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        var xi = polygon[i][0], yi = polygon[i][1];
        var xj = polygon[j][0], yj = polygon[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function isLand(x, y) {
    for (var key in LANDMASSES) {
        if (pointInPolygon([x, y], LANDMASSES[key])) {
            return true;
        }
    }
    return false;
}

function getLandmass(x, y) {
    for (var key in LANDMASSES) {
        if (pointInPolygon([x, y], LANDMASSES[key])) return key;
    }
    return null;
}

// Landmasses that share a land border (can build track between them without a ferry)
var CONNECTED_LANDMASSES = new Set([
    "continental|italy", "italy|continental",
    "continental|iberia", "iberia|continental",
    "continental|denmark", "denmark|continental",
    "zealand|denmark", "denmark|zealand",
    "denmark|scandinavia", "scandinavia|denmark",
    "zealand|scandinavia", "scandinavia|zealand"
]);

function landmassesConnected(lm1, lm2) {
    if (lm1 === lm2) return true;
    return CONNECTED_LANDMASSES.has(lm1 + "|" + lm2);
}

// Deterministic hash for terrain randomness (consistent across redraws)
function terrainHash(x, y) {
    // Simple hash: combine x,y into a pseudo-random 0-1 value
    var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
}

// Compute how deep a point is inside a polygon (0 = edge, 1 = center)
function polygonDepth(point, polygon) {
    // Minimum distance from point to any polygon edge
    var n = polygon.length - 1; // last point repeats first
    var minEdgeDist = Infinity;
    for (var i = 0; i < n; i++) {
        var j = i + 1;
        var d = segmentDistance(point[0], point[1],
            polygon[i][0], polygon[i][1], polygon[j][0], polygon[j][1]);
        if (d < minEdgeDist) minEdgeDist = d;
    }

    // Normalize by half the avg centroid-to-vertex distance (approximate inradius)
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += polygon[i][0]; cy += polygon[i][1]; }
    cx /= n; cy /= n;
    var avgR = 0;
    for (var i = 0; i < n; i++) avgR += Math.hypot(polygon[i][0] - cx, polygon[i][1] - cy);
    avgR /= n;

    return Math.min(1, minEdgeDist / (avgR * 0.5));
}

function getTerrainType(x, y) {
    var hash = terrainHash(x, y);

    // Check mountain pass corridors — override alpine terrain with clear/mountain
    for (var i = 0; i < MOUNTAIN_PASSES.length; i++) {
        var pass = MOUNTAIN_PASSES[i];
        var dist = segmentDistance(x, y, pass.from[0], pass.from[1], pass.to[0], pass.to[1]);
        if (dist <= pass.radius) {
            // 70% clear, 30% mountain — no alpine in passes
            if (hash < 0.70) return "clear";
            return "mountain";
        }
    }

    // Check alpine regions first
    for (var p = 0; p < TERRAIN_REGIONS.alpine.length; p++) {
        var polygon = TERRAIN_REGIONS.alpine[p];
        if (pointInPolygon([x, y], polygon)) {
            var depth = polygonDepth([x, y], polygon);
            // Core (depth > 0.6): 60% alpine, 30% mountain, 10% clear
            // Mid (0.3-0.6): 30% alpine, 40% mountain, 30% clear
            // Edge (< 0.3): 10% alpine, 40% mountain, 50% clear
            if (depth > 0.6) {
                if (hash < 0.60) return "alpine";
                if (hash < 0.90) return "mountain";
                return "clear";
            } else if (depth > 0.3) {
                if (hash < 0.30) return "alpine";
                if (hash < 0.70) return "mountain";
                return "clear";
            } else {
                if (hash < 0.10) return "alpine";
                if (hash < 0.50) return "mountain";
                return "clear";
            }
        }
    }

    // Check mountain regions
    for (var p = 0; p < TERRAIN_REGIONS.mountain.length; p++) {
        var polygon = TERRAIN_REGIONS.mountain[p];
        if (pointInPolygon([x, y], polygon)) {
            var depth = polygonDepth([x, y], polygon);
            // Core (depth > 0.5): 70% mountain, 15% alpine, 15% clear
            // Mid (0.25-0.5): 50% mountain, 5% alpine, 45% clear
            // Edge (< 0.25): 30% mountain, 0% alpine, 70% clear
            if (depth > 0.5) {
                if (hash < 0.70) return "mountain";
                if (hash < 0.85) return "alpine";
                return "clear";
            } else if (depth > 0.25) {
                if (hash < 0.50) return "mountain";
                if (hash < 0.55) return "alpine";
                return "clear";
            } else {
                if (hash < 0.30) return "mountain";
                return "clear";
            }
        }
    }

    return "clear";
}

function segmentDistance(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    var closestX = x1 + t * dx;
    var closestY = y1 + t * dy;
    var distX = px - closestX;
    var distY = py - closestY;
    return Math.sqrt(distX * distX + distY * distY);
}

function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    // Returns true if line segment (ax1,ay1)-(ax2,ay2) intersects (bx1,by1)-(bx2,by2)
    var dx1 = ax2 - ax1, dy1 = ay2 - ay1;
    var dx2 = bx2 - bx1, dy2 = by2 - by1;
    var denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-10) return false; // parallel
    var t = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom;
    var u = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function crossesRiver(x1, y1, x2, y2, river) {
    for (var i = 0; i < river.length - 1; i++) {
        var rx1 = river[i][0], ry1 = river[i][1];
        var rx2 = river[i + 1][0], ry2 = river[i + 1][1];
        if (segmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx2, ry2)) {
            return true;
        }
    }
    return false;
}

function edgeCrossesRiver(x1, y1, x2, y2) {
    for (var key in RIVERS) {
        if (crossesRiver(x1, y1, x2, y2, RIVERS[key])) {
            return true;
        }
    }
    return false;
}

// ============================================================================
// HEX GRID GENERATION
// ============================================================================

// Generates the hex grid and returns { mileposts, mileposts_by_id, cityToMilepost, ferryConnections }.
// Does NOT mutate any external state.
function generateHexGrid() {
    var mileposts = [];
    var mileposts_by_id = {};
    var cellSize = 1.0;
    var rowSpacing = Math.sqrt(3) / 2;

    var id = 0;
    var rowIndex = 0;
    for (var y = 6; y < 69; y += rowSpacing) {
        var isOddRow = rowIndex % 2 === 1;
        var offsetX = isOddRow ? 0.5 : 0;
        rowIndex++;

        for (var x = 15 + offsetX; x < 63; x += cellSize) {
            if (isLand(x, y)) {
                var terrain = getTerrainType(x, y);
                var landmass = getLandmass(x, y);
                var milepost = {
                    id: id,
                    x: Math.round(x * 100) / 100,
                    y: Math.round(y * 100) / 100,
                    terrain: terrain,
                    landmass: landmass,
                    city: null,
                    track: {},
                    neighbors: []
                };
                mileposts.push(milepost);
                mileposts_by_id[id] = milepost;
                id++;
            }
        }
    }

    // Build adjacency using spatial hash for O(n) performance
    var spatialHash = {};
    var bucketSize = 1.5;
    for (var m = 0; m < mileposts.length; m++) {
        var mp = mileposts[m];
        var bx = Math.floor(mp.x / bucketSize);
        var by = Math.floor(mp.y / bucketSize);
        var key = bx + "," + by;
        if (!spatialHash[key]) spatialHash[key] = [];
        spatialHash[key].push(mp.id);
    }

    for (var m = 0; m < mileposts.length; m++) {
        var mp = mileposts[m];
        var bx = Math.floor(mp.x / bucketSize);
        var by = Math.floor(mp.y / bucketSize);
        var neighbors = new Set();

        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                var key = (bx + dx) + "," + (by + dy);
                if (spatialHash[key]) {
                    for (var k = 0; k < spatialHash[key].length; k++) {
                        var otherId = spatialHash[key][k];
                        if (otherId !== mp.id) {
                            var other = mileposts_by_id[otherId];
                            var dist = Math.hypot(mp.x - other.x, mp.y - other.y);
                            if (dist < 1.5 && mp.landmass && other.landmass && landmassesConnected(mp.landmass, other.landmass)) {
                                neighbors.add(otherId);
                            }
                        }
                    }
                }
            }
        }

        mp.neighbors = Array.from(neighbors);
    }

    // Assign cities to mileposts
    var cityToMilepost = {};
    for (var cityName in CITIES) {
        var closest = null;
        var closestDist = Infinity;
        var city = CITIES[cityName];

        for (var m = 0; m < mileposts.length; m++) {
            var mp = mileposts[m];
            var dist = Math.hypot(mp.x - city.x, mp.y - city.y);
            if (dist < closestDist) {
                closestDist = dist;
                closest = mp;
            }
        }

        if (closest && closestDist < 2) {
            closest.city = Object.assign({ name: cityName }, city);
            cityToMilepost[cityName] = closest.id;
        }
    }

    // Snap ferry endpoints to nearest mileposts
    var ferryConnections = [];
    for (var f = 0; f < FERRY_ROUTES.length; f++) {
        var ferry = FERRY_ROUTES[f];
        var fromMp = null, toMp = null;
        var fromDist = Infinity, toDist = Infinity;
        for (var m = 0; m < mileposts.length; m++) {
            var mp = mileposts[m];
            var dFrom = Math.hypot(mp.x - ferry.from[0], mp.y - ferry.from[1]);
            var dTo = Math.hypot(mp.x - ferry.to[0], mp.y - ferry.to[1]);
            if (dFrom < fromDist) { fromDist = dFrom; fromMp = mp; }
            if (dTo < toDist) { toDist = dTo; toMp = mp; }
        }
        if (fromMp && toMp) {
            ferryConnections.push({
                fromId: fromMp.id,
                toId: toMp.id,
                name: ferry.name,
                cost: ferry.cost
            });
        }
    }

    return { mileposts: mileposts, mileposts_by_id: mileposts_by_id, cityToMilepost: cityToMilepost, ferryConnections: ferryConnections };
}

// Multi-source BFS from all coastal mileposts (those with <6 neighbors).
// ctx must have: mileposts, mileposts_by_id
// Returns { [milepostId]: distanceToCoast }
function computeCoastDistances(ctx) {
    var dist = {};
    var queue = [];

    for (var i = 0; i < ctx.mileposts.length; i++) {
        var mp = ctx.mileposts[i];
        if (mp.neighbors.length < 6) {
            dist[mp.id] = 0;
            queue.push(mp.id);
        }
    }

    var head = 0;
    while (head < queue.length) {
        var id = queue[head++];
        var mp = ctx.mileposts_by_id[id];
        for (var n = 0; n < mp.neighbors.length; n++) {
            var nId = mp.neighbors[n];
            if (dist[nId] === undefined) {
                dist[nId] = dist[id] + 1;
                queue.push(nId);
            }
        }
    }

    return dist;
}

// ============================================================================
// DIJKSTRA'S ALGORITHM WITH PRIORITY QUEUE
// ============================================================================

var MinHeap = (function() {
    function MinHeap() {
        this.heap = [];
    }

    MinHeap.prototype.push = function(item) {
        this.heap.push(item);
        this._bubbleUp(this.heap.length - 1);
    };

    MinHeap.prototype.pop = function() {
        if (this.heap.length === 0) return null;
        if (this.heap.length === 1) return this.heap.pop();
        var min = this.heap[0];
        this.heap[0] = this.heap.pop();
        this._bubbleDown(0);
        return min;
    };

    MinHeap.prototype._bubbleUp = function(i) {
        while (i > 0) {
            var parent = Math.floor((i - 1) / 2);
            if (this.heap[parent].cost <= this.heap[i].cost) break;
            var tmp = this.heap[parent];
            this.heap[parent] = this.heap[i];
            this.heap[i] = tmp;
            i = parent;
        }
    };

    MinHeap.prototype._bubbleDown = function(i) {
        while (true) {
            var smallest = i;
            var left = 2 * i + 1;
            var right = 2 * i + 2;
            if (left < this.heap.length && this.heap[left].cost < this.heap[smallest].cost) {
                smallest = left;
            }
            if (right < this.heap.length && this.heap[right].cost < this.heap[smallest].cost) {
                smallest = right;
            }
            if (smallest === i) break;
            var tmp = this.heap[i];
            this.heap[i] = this.heap[smallest];
            this.heap[smallest] = tmp;
            i = smallest;
        }
    };

    return MinHeap;
})();

// ctx must have: ferryConnections
function getFerryPortCost(ctx, milepostId) {
    // Returns the ferry build cost if this milepost is a ferry port, 0 otherwise
    for (var i = 0; i < ctx.ferryConnections.length; i++) {
        var ferry = ctx.ferryConnections[i];
        if (ferry.fromId === milepostId || ferry.toId === milepostId) {
            return ferry.cost;
        }
    }
    return 0;
}

// ctx must have: ferryConnections
function getFerryName(ctx, fromId, toId) {
    // Returns the ferry name for a connection between two port mileposts
    for (var i = 0; i < ctx.ferryConnections.length; i++) {
        var ferry = ctx.ferryConnections[i];
        if ((ferry.fromId === fromId && ferry.toId === toId) ||
            (ferry.toId === fromId && ferry.fromId === toId)) {
            return ferry.name;
        }
    }
    return null;
}

// Note: typo in name (double 'p') is intentional — preserved from original code.
// Will be fixed in a separate commit that updates all call sites.
function getMileppostCost(mp1, mp2) {
    // Determine base cost
    var cost = 0;

    // If destination is a city, use city cost (replaces terrain cost)
    if (mp2.city) {
        if (MAJOR_CITIES.includes(mp2.city.name)) {
            cost = 5;
        } else {
            cost = 3;
        }
    } else {
        // Use terrain cost
        if (mp2.terrain === "alpine") {
            cost = 5;
        } else if (mp2.terrain === "mountain") {
            cost = 2;
        } else {
            cost = 1;
        }
    }

    // Add river crossing cost if applicable
    if (edgeCrossesRiver(mp1.x, mp1.y, mp2.x, mp2.y)) {
        cost += 2;
    }

    return cost;
}

// Returns canonical key for a ferry connection (always smaller id first)
function getFerryKey(id1, id2) {
    return id1 < id2 ? id1 + "|" + id2 : id2 + "|" + id1;
}

// Check if player can build (claim) a ferry: must not be full (2 owners) unless player already owns it
// ctx must have: ferryOwnership
function canPlayerBuildFerry(ctx, ferryKey, playerColor) {
    var owners = ctx.ferryOwnership[ferryKey] || [];
    if (owners.includes(playerColor)) return true; // already owns it
    return owners.length < 2; // room for another owner
}

// Check if player already owns a ferry
// ctx must have: ferryOwnership
function playerOwnsFerry(ctx, ferryKey, playerColor) {
    var owners = ctx.ferryOwnership[ferryKey] || [];
    return owners.includes(playerColor);
}

// ============================================================================
// BUILD PATHFINDING (Dijkstra)
// ============================================================================

// ctx must have: mileposts, mileposts_by_id, cityToMilepost, ferryConnections,
//                ferryOwnership, tracks, activeEvents
function findPath(ctx, startId, endId, playerColor, mode, allowForeignTrack, virtualTrack, virtualEdges) {
    mode = mode || "cheapest";
    allowForeignTrack = allowForeignTrack || false;
    var dist = {};
    var prev = {};
    var costTie = {}; // secondary tiebreaker: real cost for "shortest", segment count for "cheapest"
    var heap = new MinHeap();

    // Build sets of edges owned by this player (free) and by other players (blocked/foreign)
    var ownedEdges = new Set();
    var blockedEdges = new Set();
    var foreignEdges = new Set();
    if (playerColor) {
        for (var t = 0; t < ctx.tracks.length; t++) {
            var track = ctx.tracks[t];
            var fwd = track.from + "|" + track.to;
            var rev = track.to + "|" + track.from;
            if (track.color === playerColor) {
                ownedEdges.add(fwd);
                ownedEdges.add(rev);
            } else {
                foreignEdges.add(fwd);
                foreignEdges.add(rev);
                if (!allowForeignTrack) {
                    blockedEdges.add(fwd);
                    blockedEdges.add(rev);
                }
            }
        }
    }

    // Build a lookup for ferry connections from each milepost
    var ferryFromMilepost = {};
    for (var i = 0; i < ctx.ferryConnections.length; i++) {
        var fc = ctx.ferryConnections[i];
        if (!ferryFromMilepost[fc.fromId]) ferryFromMilepost[fc.fromId] = [];
        if (!ferryFromMilepost[fc.toId]) ferryFromMilepost[fc.toId] = [];
        ferryFromMilepost[fc.fromId].push(fc);
        ferryFromMilepost[fc.toId].push(fc);
    }

    // Build set of mileposts blocked by active events for building
    var buildBlockedMileposts = new Set();
    for (var e = 0; e < ctx.activeEvents.length; e++) {
        var ae = ctx.activeEvents[e];
        var evt = ae.card;
        // Strike 123: drawing player cannot build at all (handled by caller check)
        if (evt.type === "snow" || evt.type === "fog" || evt.type === "gale") {
            // Collect all zone center mileposts and BFS from each
            var centers = [];
            if (evt.city) {
                var cId = ctx.cityToMilepost[evt.city];
                if (cId !== undefined) centers.push(cId);
            }
            if (evt.seaAreas) {
                var coastalStarts = getCoastalMilepostsForSeaAreas(ctx, evt.seaAreas);
                for (var c = 0; c < coastalStarts.length; c++) centers.push(coastalStarts[c]);
            }
            // Multi-source BFS from all centers; coastal mileposts count as #1
            var seaRadius = evt.seaAreas ? evt.radius - 1 : evt.radius;
            var zoneIds = centers.length > 0 ? getMilepostsInHexRangeMultiSource(ctx, centers, seaRadius) : new Set();
            zoneIds.forEach(function(zid) {
                // Snow only blocks building in mountain/alpine mileposts;
                // Fog and Gale block all mileposts in the zone
                if (evt.type === "snow") {
                    var mp = ctx.mileposts_by_id[zid];
                    if (evt.blockedTerrain && evt.blockedTerrain.includes(mp.terrain)) {
                        buildBlockedMileposts.add(zid);
                    }
                } else {
                    buildBlockedMileposts.add(zid);
                }
            });
        }
    }

    for (var i = 0; i < ctx.mileposts.length; i++) {
        var mp = ctx.mileposts[i];
        dist[mp.id] = Infinity;
        costTie[mp.id] = Infinity;
        prev[mp.id] = null;
    }
    dist[startId] = 0;
    costTie[startId] = 0;
    heap.push({ id: startId, cost: 0 });

    while (true) {
        var item = heap.pop();
        if (!item) break;
        var current = ctx.mileposts_by_id[item.id];

        if (item.cost > dist[current.id]) continue;
        if (current.id === endId) break;

        // Traverse land neighbors
        for (var n = 0; n < current.neighbors.length; n++) {
            var neighborId = current.neighbors[n];
            var neighbor = ctx.mileposts_by_id[neighborId];
            var edgeKey = current.id + "|" + neighborId;
            // Cannot build on edges owned by other players (unless foreign track allowed)
            if (blockedEdges.has(edgeKey)) continue;
            // Cannot build into event-blocked mileposts (snow/fog/gale zones)
            if (buildBlockedMileposts.has(neighborId)) continue;
            // If player already owns this edge, weight is 0 in cheapest mode
            var isOwned = ownedEdges.has(edgeKey);
            var isForeign = foreignEdges.has(edgeKey);
            var isVirtual = virtualEdges
                ? virtualEdges.has(current.id + '|' + neighborId)
                : (virtualTrack && virtualTrack.has(current.id) && virtualTrack.has(neighborId));
            var realEdgeCost = (isOwned || isForeign || isVirtual) ? 0 : getMileppostCost(current, neighbor);
            // In "shortest" mode, every edge costs 1 (even owned ones) to find the
            // path with fewest total segments rather than detouring through existing track.
            // In "cheapest" mode, owned edges are free, foreign edges are free (no build cost).
            // In "shortest" mode, foreign edges cost 1 (passable but not free — prevents wild detours).
            var edgeWeight = mode === "shortest" ? 1 : realEdgeCost;
            var newDist = dist[current.id] + edgeWeight;
            // Tiebreaker: in "shortest" mode, prefer lower real cost; in "cheapest" mode, prefer fewer segments
            var newCostTie = costTie[current.id] + (mode === "shortest" ? realEdgeCost : 1);

            if (newDist < dist[neighbor.id] || (newDist === dist[neighbor.id] && newCostTie < costTie[neighbor.id])) {
                dist[neighbor.id] = newDist;
                costTie[neighbor.id] = newCostTie;
                prev[neighbor.id] = current.id;
                heap.push({ id: neighbor.id, cost: newDist });
            }
        }

        // Traverse ferry connections from this milepost
        var ferries = ferryFromMilepost[current.id] || [];
        for (var f = 0; f < ferries.length; f++) {
            var fc = ferries[f];
            var neighborId = fc.fromId === current.id ? fc.toId : fc.fromId;
            var ferryKey = getFerryKey(fc.fromId, fc.toId);

            // Block ferry building if either port is in a gale/snow/fog build-blocked zone
            if (buildBlockedMileposts.has(current.id) || buildBlockedMileposts.has(neighborId)) continue;

            // Check if ferry is available to this player
            if (!canPlayerBuildFerry(ctx, ferryKey, playerColor)) continue;

            var alreadyOwned = playerOwnsFerry(ctx, ferryKey, playerColor);
            var realFerryCost = alreadyOwned ? 0 : fc.cost;
            // Add city entry cost if ferry destination is a city
            if (!alreadyOwned) {
                var destMp = ctx.mileposts_by_id[neighborId];
                if (destMp.city) {
                    realFerryCost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                }
            }
            var edgeWeight = mode === "shortest" ? 1 : realFerryCost;
            var newDist = dist[current.id] + edgeWeight;
            var newCostTie = costTie[current.id] + (mode === "shortest" ? realFerryCost : 1);

            if (newDist < dist[neighborId] || (newDist === dist[neighborId] && newCostTie < costTie[neighborId])) {
                dist[neighborId] = newDist;
                costTie[neighborId] = newCostTie;
                prev[neighborId] = current.id;
                heap.push({ id: neighborId, cost: newDist });
            }
        }
    }

    if (dist[endId] === Infinity) {
        return null;
    }

    var path = [];
    var current = endId;
    while (current !== null) {
        path.unshift(current);
        current = prev[current];
    }

    // Always compute real build cost by walking the path
    var realCost = 0;
    var foreignSegments = [];
    for (var i = 0; i < path.length - 1; i++) {
        var edgeKey = path[i] + "|" + path[i + 1];
        if (ownedEdges.has(edgeKey)) continue; // already own this track segment

        // Track foreign segments (no build cost for these)
        if (foreignEdges.has(edgeKey)) {
            foreignSegments.push(i);
            continue;
        }

        // Check if this is a ferry edge
        var ferryKey = getFerryKey(path[i], path[i + 1]);
        var isFerryEdge = false;
        for (var f = 0; f < ctx.ferryConnections.length; f++) {
            var fc = ctx.ferryConnections[f];
            if (getFerryKey(fc.fromId, fc.toId) === ferryKey) {
                isFerryEdge = true;
                if (!playerOwnsFerry(ctx, ferryKey, playerColor)) {
                    realCost += fc.cost;
                    // Add city entry cost if ferry destination is a city
                    var destMp = ctx.mileposts_by_id[path[i + 1]];
                    if (destMp.city) {
                        realCost += MAJOR_CITIES.includes(destMp.city.name) ? 5 : 3;
                    }
                }
                break;
            }
        }

        if (!isFerryEdge) {
            var mp1 = ctx.mileposts_by_id[path[i]];
            var mp2 = ctx.mileposts_by_id[path[i + 1]];
            realCost += getMileppostCost(mp1, mp2);
        }
    }

    return { path: path, cost: realCost, foreignSegments: foreignSegments };
}

// Check if an active gale 138 event blocks ferry movement between two ports
// ctx must have: activeEvents, cityToMilepost, mileposts, mileposts_by_id
function isGaleBlockingFerry(ctx, portId1, portId2) {
    for (var i = 0; i < ctx.activeEvents.length; i++) {
        var ae = ctx.activeEvents[i];
        if (ae.card.id === 138) {
            if (isMilepostInEventZone(ctx, ae.card, portId1) || isMilepostInEventZone(ctx, ae.card, portId2)) {
                return true;
            }
        }
    }
    return false;
}

// ============================================================================
// TRACK-BASED PATHFINDING (for train movement along built track)
// ============================================================================

// ctx must have: mileposts_by_id, cityToMilepost, tracks, ferryConnections,
//                ferryOwnership, activeEvents, players
function findPathOnTrack(ctx, startId, endId, playerColor, allowForeignTrack) {
    allowForeignTrack = allowForeignTrack || false;
    var visited = new Set([startId]);
    var prev = {};
    var ferryEdgeSet = new Set(); // track which edges are ferry crossings
    var foreignEdgeSet = new Set(); // track which edges use foreign track
    prev[startId] = null;
    var queue = [startId];

    // Build set of mileposts the player has track at
    var playerMileposts = getPlayerOwnedMileposts(ctx, playerColor);

    // Strike 123: collect colors of players whose rail lines are shut down
    var struckColors = new Set();
    for (var i = 0; i < ctx.activeEvents.length; i++) {
        var ae = ctx.activeEvents[i];
        if (ae.card.id === 123) {
            struckColors.add(ctx.players[ae.drawingPlayerIndex].color);
        }
    }

    // Snow: collect set of blocked milepost IDs (terrain type per card)
    var snowBlockedMileposts = new Set();
    for (var i = 0; i < ctx.activeEvents.length; i++) {
        var ae = ctx.activeEvents[i];
        if (ae.card.type === "snow") {
            var cityMpId = ctx.cityToMilepost[ae.card.city];
            if (cityMpId === undefined) continue;
            var inRange = getMilepostsInHexRange(ctx, cityMpId, ae.card.radius);
            inRange.forEach(function(id) {
                var mp = ctx.mileposts_by_id[id];
                if (ae.card.blockedTerrain && ae.card.blockedTerrain.includes(mp.terrain)) {
                    snowBlockedMileposts.add(id);
                }
            });
        }
    }

    while (queue.length > 0) {
        var current = queue.shift();
        if (current === endId) break;

        // Traverse built track (own track always, foreign track if allowed)
        for (var t = 0; t < ctx.tracks.length; t++) {
            var track = ctx.tracks[t];
            if (struckColors.has(track.color)) continue; // Strike 123: no movement on struck player's rails
            var isOwn = track.color === playerColor;
            if (!isOwn && !allowForeignTrack) continue;
            var neighbor = null;
            if (track.from === current) neighbor = track.to;
            else if (track.to === current) neighbor = track.from;

            if (neighbor && !visited.has(neighbor)) {
                if (snowBlockedMileposts.has(neighbor)) continue; // Snow: blocked mountain/alpine
                visited.add(neighbor);
                prev[neighbor] = current;
                if (!isOwn) {
                    foreignEdgeSet.add(current + "|" + neighbor);
                }
                queue.push(neighbor);
            }
        }

        // Traverse ferry connections (only if player owns this ferry)
        for (var f = 0; f < ctx.ferryConnections.length; f++) {
            var ferry = ctx.ferryConnections[f];
            var neighbor = null;
            if (ferry.fromId === current) neighbor = ferry.toId;
            else if (ferry.toId === current) neighbor = ferry.fromId;

            if (neighbor && !visited.has(neighbor)) {
                var ferryKey = getFerryKey(ferry.fromId, ferry.toId);
                if (playerOwnsFerry(ctx, ferryKey, playerColor)) {
                    // Gale 138: no ferry movement if either port is in the gale zone
                    if (isGaleBlockingFerry(ctx, ferry.fromId, ferry.toId)) continue;
                    visited.add(neighbor);
                    prev[neighbor] = current;
                    ferryEdgeSet.add(current + "|" + neighbor);
                    queue.push(neighbor);
                }
            }
        }
    }

    if (!visited.has(endId)) {
        return null;
    }

    // Reconstruct path and find ferry crossings + foreign segments
    var path = [];
    var ferryCrossings = []; // indices in path where ferry crossing starts
    var foreignSegments = []; // indices in path where foreign track is used
    var current = endId;
    while (current !== null) {
        path.unshift(current);
        current = prev[current];
    }

    // Identify ferry crossings and foreign segments in the path
    for (var i = 0; i < path.length - 1; i++) {
        var edgeKey = path[i] + "|" + path[i + 1];
        if (ferryEdgeSet.has(edgeKey)) {
            ferryCrossings.push(i);
        }
        if (foreignEdgeSet.has(edgeKey)) {
            foreignSegments.push(i);
        }
    }

    return { path: path, ferryCrossings: ferryCrossings, foreignSegments: foreignSegments };
}

// ============================================================================
// PLAYER TRACK OWNERSHIP
// ============================================================================

// ctx must have: tracks, ferryConnections, ferryOwnership
function getPlayerOwnedMileposts(ctx, playerColor) {
    var owned = new Set();
    for (var t = 0; t < ctx.tracks.length; t++) {
        var track = ctx.tracks[t];
        if (track.color === playerColor) {
            owned.add(track.from);
            owned.add(track.to);
        }
    }
    // Include ferry port endpoints the player owns
    for (var f = 0; f < ctx.ferryConnections.length; f++) {
        var fc = ctx.ferryConnections[f];
        var ferryKey = getFerryKey(fc.fromId, fc.toId);
        if (playerOwnsFerry(ctx, ferryKey, playerColor)) {
            owned.add(fc.fromId);
            owned.add(fc.toId);
        }
    }
    return owned;
}

// ============================================================================
// EVENT ZONE HELPERS
// ============================================================================

// BFS from a milepost, returning Set of all milepost IDs within N hex hops
// ctx must have: mileposts_by_id
function getMilepostsInHexRange(ctx, startId, radius) {
    var result = new Set([startId]);
    var queue = [startId];
    var dist = {};
    dist[startId] = 0;

    var head = 0;
    while (head < queue.length) {
        var id = queue[head++];
        if (dist[id] >= radius) continue;
        var mp = ctx.mileposts_by_id[id];
        for (var n = 0; n < mp.neighbors.length; n++) {
            var nId = mp.neighbors[n];
            if (dist[nId] === undefined) {
                dist[nId] = dist[id] + 1;
                result.add(nId);
                queue.push(nId);
            }
        }
    }
    return result;
}

// Get all coastal mileposts that border the given sea areas.
// ctx must have: mileposts
function getCoastalMilepostsForSeaAreas(ctx, areaNames) {
    var targetSet = new Set(areaNames);
    var result = [];
    for (var i = 0; i < ctx.mileposts.length; i++) {
        var mp = ctx.mileposts[i];
        if (mp.neighbors.length >= 6) continue; // not coastal
        // Eastern map edge mileposts aren't truly coastal — in reality
        // there is more landmass to the east (Asia/Eastern Europe).
        // Skip them so they don't act as gale origin points.
        if (mp.x >= 62) continue;
        var nearestArea = null;
        var nearestDist = Infinity;
        for (var name in SEA_AREAS) {
            var points = SEA_AREAS[name];
            for (var p = 0; p < points.length; p++) {
                var pt = points[p];
                var d = Math.hypot(mp.x - pt.x, mp.y - pt.y);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearestArea = name;
                }
            }
        }
        if (nearestArea && targetSet.has(nearestArea)) {
            result.push(mp.id);
        }
    }
    return result;
}

// Multi-source BFS from multiple starting mileposts simultaneously.
// Returns Set of all milepost IDs within radius hex hops of ANY start.
// ctx must have: mileposts_by_id
function getMilepostsInHexRangeMultiSource(ctx, startIds, radius) {
    var result = new Set(startIds);
    var queue = [];
    var dist = {};
    for (var i = 0; i < startIds.length; i++) {
        queue.push(startIds[i]);
        dist[startIds[i]] = 0;
    }

    var head = 0;
    while (head < queue.length) {
        var id = queue[head++];
        if (dist[id] >= radius) continue;
        var mp = ctx.mileposts_by_id[id];
        for (var n = 0; n < mp.neighbors.length; n++) {
            var nId = mp.neighbors[n];
            if (dist[nId] === undefined) {
                dist[nId] = dist[id] + 1;
                result.add(nId);
                queue.push(nId);
            }
        }
    }
    return result;
}

// Check if a milepost is within an event's affected zone using hex distance.
// ctx must have: cityToMilepost, mileposts, mileposts_by_id
function isMilepostInEventZone(ctx, evt, milepostId) {
    var radius = evt.radius || 0;
    if (evt.city) {
        var cityMpId = ctx.cityToMilepost[evt.city];
        if (cityMpId !== undefined) {
            var inRange = getMilepostsInHexRange(ctx, cityMpId, radius);
            if (inRange.has(milepostId)) return true;
        }
    }
    if (evt.seaAreas) {
        var coastalStarts = getCoastalMilepostsForSeaAreas(ctx, evt.seaAreas);
        // Coastal milepost counts as #1, so go radius-1 more hops inland
        var inRange = getMilepostsInHexRangeMultiSource(ctx, coastalStarts, radius - 1);
        if (inRange.has(milepostId)) return true;
    }
    return false;
}

// ============================================================================
// EXPORTS
// ============================================================================

var exports = {
    // Constants
    WORLD_BOUNDS: WORLD_BOUNDS,
    MAJOR_CITIES: MAJOR_CITIES,
    CITIES: CITIES,
    GOODS: GOODS,
    SPEED_TIERS: SPEED_TIERS,
    TRAIN_TYPES: TRAIN_TYPES,
    getTrainMovement: getTrainMovement,
    EVENT_TYPES: EVENT_TYPES,
    COLOR_MAP: COLOR_MAP,
    LANDMASSES: LANDMASSES,
    CONNECTED_LANDMASSES: CONNECTED_LANDMASSES,
    TERRAIN_REGIONS: TERRAIN_REGIONS,
    RIVERS: RIVERS,
    FERRY_ROUTES: FERRY_ROUTES,
    SEA_AREAS: SEA_AREAS,
    EVENT_CARDS: EVENT_CARDS,
    GOODS_ICONS: GOODS_ICONS,

    // Geometry helpers
    pointInPolygon: pointInPolygon,
    isLand: isLand,
    getLandmass: getLandmass,
    landmassesConnected: landmassesConnected,
    terrainHash: terrainHash,
    polygonDepth: polygonDepth,
    getTerrainType: getTerrainType,
    segmentDistance: segmentDistance,
    segmentsIntersect: segmentsIntersect,
    crossesRiver: crossesRiver,
    edgeCrossesRiver: edgeCrossesRiver,

    // Grid generation
    generateHexGrid: generateHexGrid,
    computeCoastDistances: computeCoastDistances,

    // Pathfinding support
    MinHeap: MinHeap,
    getFerryPortCost: getFerryPortCost,
    getFerryName: getFerryName,
    getMileppostCost: getMileppostCost,
    getFerryKey: getFerryKey,
    canPlayerBuildFerry: canPlayerBuildFerry,
    playerOwnsFerry: playerOwnsFerry,
    getPlayerOwnedMileposts: getPlayerOwnedMileposts,

    // Pathfinding
    findPath: findPath,
    findPathOnTrack: findPathOnTrack,
    isGaleBlockingFerry: isGaleBlockingFerry,

    // Event zone helpers
    getMilepostsInHexRange: getMilepostsInHexRange,
    getCoastalMilepostsForSeaAreas: getCoastalMilepostsForSeaAreas,
    getMilepostsInHexRangeMultiSource: getMilepostsInHexRangeMultiSource,
    isMilepostInEventZone: isMilepostInEventZone
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;  // Node.js
} else {
    for (var k in exports) {
        if (exports.hasOwnProperty(k)) {
            root[k] = exports[k];  // Browser global
        }
    }
}
})(typeof window !== 'undefined' ? window : this);
