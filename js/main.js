// --- Configuration ---
const CALIBRATION_CLICKS_NEEDED = 5; // Clicks per point to calibrate
let gazeData = []; // Store X,Y coordinates
let isTracking = false;
let heatmapInstance = null;
let perPageHeatmaps = {}; // store heatmap instances by page
let pdfDoc = null;
const PAGE_RENDER_SCALE = 1.5;

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
				// Map gaze to PDF page if possible
				const mapped = mapGazeToPdf(data.x, data.y);
				if (mapped) {
					gazeData.push({
						page: mapped.page,
						x: mapped.x,
						y: mapped.y,
						value: 1,
					});
				} else {
					// fallback: store viewport points (not used for PDF heatmaps)
					gazeData.push({
						page: null,
						x: Math.floor(data.x),
						y: Math.floor(data.y),
						value: 1,
					});
				}
			}
		})
		.saveDataAcrossSessions(false) // Don't save calibration to localstorage for this demo
		.begin();

	// Show video feed (user feedback for head position)
	webgazer.showVideoPreview(true);
	webgazer.showPredictionPoints(true); /* Shows the red dot */

	updateStatus('Camera ready. Please Start Calibration.');

	// PDF.js worker setup (CDN)
	if (window['pdfjsLib']) {
		pdfjsLib.GlobalWorkerOptions.workerSrc =
			'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';
		setupPdfInput();
	} else {
		console.warn('pdfjsLib not found; PDF upload disabled.');
	}
};
// --- PDF Upload & Rendering ---
function setupPdfInput() {
	const input = document.getElementById('pdfInput');
	if (!input) return;
	input.addEventListener('change', (e) => {
		const file = e.target.files && e.target.files[0];
		if (file) loadPdfFile(file);
	});
}

async function loadPdfFile(file) {
	const url = URL.createObjectURL(file);
	updateStatus('Loading PDF...');
	pdfDoc = await pdfjsLib.getDocument({ url }).promise;
	const viewer = document.getElementById('pdfViewer');
	viewer.innerHTML = '';
	for (let p = 1; p <= pdfDoc.numPages; p++) {
		const page = await pdfDoc.getPage(p);
		await renderPage(page, p, viewer);
	}
	updateStatus(`Loaded PDF (${pdfDoc.numPages} pages).`);
}

async function renderPage(page, pageNumber, viewer) {
	const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });

	const pageWrapper = document.createElement('div');
	pageWrapper.className = 'pdf-page';
	pageWrapper.style.width = `${Math.floor(viewport.width)}px`;
	pageWrapper.dataset.pageNumber = pageNumber;

	const canvas = document.createElement('canvas');
	canvas.className = 'pdf-canvas';
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	const ctx = canvas.getContext('2d');

	const renderContext = { canvasContext: ctx, viewport };
	await page.render(renderContext).promise;

	// overlay for heatmap and highlights
	const overlay = document.createElement('div');
	overlay.className = 'pdf-overlay';
	overlay.style.width = canvas.width + 'px';
	overlay.style.height = canvas.height + 'px';

	pageWrapper.appendChild(canvas);
	pageWrapper.appendChild(overlay);
	viewer.appendChild(pageWrapper);

	// create a heatmap container object for this page overlay (instance lazy-created)
	perPageHeatmaps[pageNumber] = {
		overlay,
		instance: null,
		width: canvas.width,
		height: canvas.height,
	};
}

// Map a viewport gaze coordinate to a PDF page and page-relative coordinates
function mapGazeToPdf(dataX, dataY) {
	const el = document.elementFromPoint(dataX, dataY);
	if (!el) return null;

	const pageEl = el.closest('.pdf-page');
	if (!pageEl) return null;

	const pageNum = parseInt(pageEl.dataset.pageNumber, 10);
	const canvas = pageEl.querySelector('canvas.pdf-canvas');
	const rect = canvas.getBoundingClientRect();

	const x = Math.round(dataX - rect.left);
	const y = Math.round(dataY - rect.top);

	// clamp
	const px = Math.max(0, Math.min(x, rect.width));
	const py = Math.max(0, Math.min(y, rect.height));

	return {
		page: pageNum,
		x: Math.floor((px / rect.width) * perPageHeatmaps[pageNum].width),
		y: Math.floor((py / rect.height) * perPageHeatmaps[pageNum].height),
	};
}

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
	// If PDF pages exist, render per-page heatmaps
	if (pdfDoc && Object.keys(perPageHeatmaps).length > 0) {
		// For each page, create or update heatmap on the overlay
		Object.keys(perPageHeatmaps).forEach((p) => {
			const pageNum = parseInt(p, 10);
			const info = perPageHeatmaps[pageNum];
			if (!info) return;

			// Clear previous overlay children (heatmap canvas etc.)
			info.overlay.innerHTML = '';

			const pageContainer = document.createElement('div');
			pageContainer.style.width = info.width + 'px';
			pageContainer.style.height = info.height + 'px';
			pageContainer.style.position = 'absolute';
			pageContainer.style.top = '0';
			pageContainer.style.left = '0';

			info.overlay.appendChild(pageContainer);

			// Prepare data for this page
			const pagePoints = gazeData
				.filter((g) => g.page === pageNum)
				.map((g) => ({ x: g.x, y: g.y, value: g.value }));

			// create heatmap instance for the page
			if (info.instance) {
				info.instance.setData({ max: 5, data: pagePoints });
			} else {
				info.instance = h337.create({
					container: pageContainer,
					radius: 30,
					maxOpacity: 0.6,
					minOpacity: 0,
					blur: 0.75,
				});
				info.instance.setData({ max: 5, data: pagePoints });
			}

			// Add a simple centroid highlight for densest area (basic approximation)
			// Compute a quick grid density to find densest bin
			if (pagePoints.length > 0) {
				const GRID = 8;
				const counts = {};
				pagePoints.forEach((pt) => {
					const gx = Math.floor((pt.x / info.width) * GRID);
					const gy = Math.floor((pt.y / info.height) * GRID);
					const key = gx + ',' + gy;
					counts[key] = (counts[key] || 0) + pt.value;
				});
				// find max bin
				let maxKey = null;
				let maxVal = 0;
				Object.keys(counts).forEach((k) => {
					if (counts[k] > maxVal) {
						maxVal = counts[k];
						maxKey = k;
					}
				});
				if (maxKey) {
					const [gx, gy] = maxKey.split(',').map(Number);
					const boxW = Math.round(info.width / GRID);
					const boxH = Math.round(info.height / GRID);
					const left = gx * boxW;
					const top = gy * boxH;
					const highlight = document.createElement('div');
					highlight.className = 'text-highlight';
					highlight.style.left = left + 'px';
					highlight.style.top = top + 'px';
					highlight.style.width = boxW + 'px';
					highlight.style.height = boxH + 'px';
					info.overlay.appendChild(highlight);
				}
			}
		});

		updateStatus(
			`Heatmap generated for PDF (${
				gazeData.filter((g) => g.page).length
			} gaze points assigned to pages).`
		);
		return;
	}

	// Fallback: single-page/global heatmap
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
