// --- Configuration ---
const CALIBRATION_CLICKS_NEEDED = 5; // Clicks per point to calibrate
let gazeData = []; // Store X,Y coordinates
let isTracking = false;
let heatmapInstance = null;

// Calibration Points (Percentages of screen width/height)
const calibrationPoints = [
	{ x: 10, y: 10 },
	{ x: 50, y: 10 },
	{ x: 90, y: 10 },
	{ x: 10, y: 50 },
	{ x: 50, y: 50 },
	{ x: 90, y: 50 },
	{ x: 10, y: 90 },
	{ x: 50, y: 90 },
	{ x: 90, y: 90 },
];

window.onload = async function () {
	updateStatus('Requesting camera access...');

	// Initialize WebGazer
	// We use the 'ridge' regression model which is generally stable for webcams
	await webgazer
		.setRegression('ridge')
		.setGazeListener(function (data, clock) {
			if (data && isTracking) {
				// Store data for heatmap
				// WebGazer gives us x,y coordinates relative to the viewport
				gazeData.push({
					x: Math.floor(data.x),
					y: Math.floor(data.y),
					value: 1, // Intensity of this point (1 = standard gaze)
				});
			}
		})
		.saveDataAcrossSessions(false) // Don't save calibration to localstorage for this demo
		.begin();

	// Show video feed (user feedback for head position)
	webgazer.showVideoPreview(true);
	webgazer.showPredictionPoints(true); /* Shows the red dot */

	updateStatus('Camera ready. Please Start Calibration.');
};

// --- Calibration Logic ---
function startCalibration() {
	const container = document.getElementById('calibrationDiv');
	container.classList.remove('hidden');
	container.innerHTML = ''; // Clear old points
	gazeData = []; // Clear old data
	updateStatus('Click each red dot 5 times while looking at it.');

	// Create dots
	calibrationPoints.forEach((pos, index) => {
		const dot = document.createElement('div');
		dot.className = 'calibration-point';
		dot.style.left = `${pos.x}%`;
		dot.style.top = `${pos.y}%`;
		dot.dataset.clicks = 0;
		dot.id = `pt-${index}`;

		// Logic for clicking dots
		dot.addEventListener('click', (e) => {
			// Must allow pointer events temporarily for calibration
			document.getElementById('calibrationDiv').style.pointerEvents = 'auto';

			const clicks = parseInt(dot.dataset.clicks) + 1;
			dot.dataset.clicks = clicks;

			// Calculate opacity based on clicks (0.2 to 1.0)
			const opacity = Math.min(
				1,
				0.2 + (clicks / CALIBRATION_CLICKS_NEEDED) * 0.8
			);
			dot.style.opacity = opacity;

			if (clicks >= CALIBRATION_CLICKS_NEEDED) {
				dot.style.backgroundColor = '#4ade80'; // Green
				dot.classList.add('calibrated');
			}

			checkCalibrationComplete();
		});

		container.appendChild(dot);
	});

	// Enable interaction with calibration layer
	document.getElementById('calibrationDiv').style.pointerEvents = 'auto';

	// Hide heatmap if open
	document.getElementById('heatmapContainer').style.display = 'none';
}

function checkCalibrationComplete() {
	const dots = document.querySelectorAll('.calibration-point');
	const allDone = Array.from(dots).every((d) =>
		d.classList.contains('calibrated')
	);

	if (allDone) {
		updateStatus('Calibration Complete! Recording gaze...');
		setTimeout(() => {
			document.getElementById('calibrationDiv').classList.add('hidden');
			document.getElementById('calibrationDiv').style.pointerEvents = 'none'; // Pass through again
			document.getElementById('heatmapBtn').classList.remove('hidden');
			isTracking = true;
		}, 500);
	}
}

// --- Heatmap Logic ---
function toggleHeatmap() {
	const container = document.getElementById('heatmapContainer');
	const btn = document.getElementById('heatmapBtn');

	if (container.style.display === 'block') {
		// Hide Heatmap
		container.style.display = 'none';
		btn.innerText = '2. Generate Heatmap';
		isTracking = true; // Resume tracking
		webgazer.showPredictionPoints(true);
	} else {
		// Show Heatmap
		isTracking = false; // Pause tracking so we don't record looking at the heatmap
		webgazer.showPredictionPoints(false); // Hide red dot
		container.style.display = 'block';
		btn.innerText = 'Hide Heatmap';
		renderHeatmap();
	}
}

function renderHeatmap() {
	const container = document.getElementById('heatmapContainer');
	container.innerHTML = ''; // Clear previous canvas

	// Initialize heatmap instance
	heatmapInstance = h337.create({
		container: container,
		radius: 40, // Radius of the "eye spot"
		maxOpacity: 0.6,
		minOpacity: 0,
		blur: 0.75,
	});

	// Filter/Prepare data
	// Heatmap.js expects {x, y, value}
	const max = 5; // Maximum intensity threshold

	heatmapInstance.setData({
		max: max,
		data: gazeData,
	});

	updateStatus(`Heatmap generated from ${gazeData.length} gaze points.`);
}

function resetData() {
	gazeData = [];
	if (heatmapInstance) heatmapInstance.setData({ max: 0, data: [] });
	document.getElementById('heatmapContainer').style.display = 'none';
	updateStatus('Data cleared.');
	webgazer.clearData();
}

function updateStatus(msg) {
	document.getElementById('statusMsg').innerText = msg;
}

// Cleanup on close
window.onbeforeunload = function () {
	webgazer.end();
};
