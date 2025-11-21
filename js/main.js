// --- Configuration ---
const CALIBRATION_CLICKS_NEEDED = 5; // Clicks per point to calibrate
let gazeData = []; // Store X,Y coordinates
let isTracking = false;
let heatmapInstance = null;
let perPageHeatmaps = {}; // store heatmap instances by page
let pdfDoc = null;
const PAGE_RENDER_SCALE = 1.5;
// --- Fixation detection / smoothing params ---
const DISPERSION_THRESHOLD = 60; // pixels
const MIN_FIXATION_DURATION = 150; // ms
let sampleBuffer = []; // {x,y,t}
let fixationRecords = []; // {page,x,y,start,end,duration}

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
					// store raw gaze point for heatmap
					gazeData.push({
						page: mapped.page,
						x: mapped.x,
						y: mapped.y,
						value: 1,
					});
					// if text items exist, increment the matching text span count
					const pageInfo = perPageHeatmaps[mapped.page];
					if (pageInfo && pageInfo.textItems && pageInfo.textItems.length) {
						for (let ti of pageInfo.textItems) {
							const r = ti.rect;
							if (
								mapped.x >= r.left &&
								mapped.x <= r.left + r.width &&
								mapped.y >= r.top &&
								mapped.y <= r.top + r.height
							) {
								pageInfo.textCounts[ti.idx] =
									(pageInfo.textCounts[ti.idx] || 0) + 1;
								updateTextHighlights(mapped.page);
								break;
							}
						}
					}
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
		.setGazeListener(function (data, clock) {
			if (data && isTracking) {
				const t = clock || Date.now();
				// Push sample into buffer (viewport coords)
				sampleBuffer.push({ x: Math.floor(data.x), y: Math.floor(data.y), t });
				// keep buffer short (last 1s)
				const cutoff = t - 1000;
				sampleBuffer = sampleBuffer.filter((s) => s.t >= cutoff);
				// try to detect fixation
				processSamples();
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

	// add a text layer container
	const textLayer = document.createElement('div');
	textLayer.className = 'text-layer';
	textLayer.style.width = canvas.width + 'px';
	textLayer.style.height = canvas.height + 'px';
	pageWrapper.appendChild(textLayer);

	viewer.appendChild(pageWrapper);

	// create a heatmap container object for this page overlay (instance lazy-created)
	perPageHeatmaps[pageNumber] = {
		overlay,
		instance: null,
		width: canvas.width,
		height: canvas.height,
		textItems: [],
		textCounts: {},
		textLayer,
	};

	// Render text layer and compute text item bounding boxes
	renderTextLayer(page, pageNumber, viewport, textLayer);
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

function processSamples() {
	if (sampleBuffer.length < 3) return; // need a few samples
	const startT = sampleBuffer[0].t;
	const endT = sampleBuffer[sampleBuffer.length - 1].t;
	const duration = endT - startT;

	const xs = sampleBuffer.map((s) => s.x);
	const ys = sampleBuffer.map((s) => s.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const dispersion = (maxX - minX) + (maxY - minY);

	if (duration >= MIN_FIXATION_DURATION && dispersion <= DISPERSION_THRESHOLD) {
		// compute centroid
		const sumX = xs.reduce((a, b) => a + b, 0);
		const sumY = ys.reduce((a, b) => a + b, 0);
		const cx = Math.round(sumX / xs.length);
		const cy = Math.round(sumY / ys.length);

		// map centroid to pdf page
		const mapped = mapGazeToPdf(cx, cy);
		const fixation = { page: mapped ? mapped.page : null, x: mapped ? mapped.x : cx, y: mapped ? mapped.y : cy, start: startT, end: endT, duration };
		fixationRecords.push(fixation);

		// update per-page text stats if applicable
		if (mapped) {
			const info = perPageHeatmaps[mapped.page];
			if (info) {
				// ensure heatmap instance
				if (!info.instance) {
					const container = document.createElement('div');
					container.style.width = info.width + 'px';
					container.style.height = info.height + 'px';
					container.style.position = 'absolute';
					container.style.top = '0';
					container.style.left = '0';
					info.overlay.appendChild(container);
					info.instance = h337.create({ container, radius: 30, maxOpacity: 0.6, minOpacity: 0, blur: 0.75 });
				}

				// add to heatmap (scale value by duration)
				info.instance.addData({ x: mapped.x, y: mapped.y, value: Math.max(1, Math.round(mapped.duration ? mapped.duration / 100 : Math.max(1, Math.round(duration / 100)))) || Math.max(1, Math.round(duration / 100)) });

				// map to text item
				if (info.textItems && info.textItems.length) {
					for (let ti of info.textItems) {
						const r = ti.rect;
						if (mapped.x >= r.left && mapped.x <= r.left + r.width && mapped.y >= r.top && mapped.y <= r.top + r.height) {
							const stat = info.textCounts[ti.idx] || { count: 0, duration: 0 };
							stat.count += 1;
							stat.duration += duration;
							info.textCounts[ti.idx] = stat;
							updateTextHighlights(mapped.page);
							break;
						}
					}
				}
			}
		}

		// clear buffer after fixation detection
		sampleBuffer = [];
	}
}

async function renderTextLayer(page, pageNumber, viewport, textLayer) {
	const textContent = await page.getTextContent();
	const items = textContent.items;

	perPageHeatmaps[pageNumber].textItems = [];

	items.forEach((item, idx) => {
		// item.transform: [a, b, c, d, e, f]
		const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
		const left = tx[4];
		// top needs adjustment since PDF coordinates origin differs
		const top = tx[5] - (item.height || 0);
		const fontHeight = Math.hypot(tx[1], tx[3]);

		const span = document.createElement('span');
		span.className = 'text-span';
		span.dataset.index = idx;
		span.textContent = item.str;
		span.style.left = left + 'px';
		span.style.top = top + 'px';
		span.style.fontSize = fontHeight + 'px';
		span.style.lineHeight = fontHeight + 'px';
		textLayer.appendChild(span);

		const rect = {
			left: Math.round(left),
			top: Math.round(top),
			width: Math.round(item.width || 10),
			height: Math.round(fontHeight),
		};
		perPageHeatmaps[pageNumber].textItems.push({ rect, str: item.str, idx });
	});
}

function updateTextHighlights(pageNumber) {
	const info = perPageHeatmaps[pageNumber];
	if (!info) return;

	// remove existing highlight overlays
	const existing = info.overlay.querySelectorAll('.text-highlight');
	existing.forEach((el) => el.remove());

	const counts = info.textCounts || {};
	const entries = Object.keys(counts).map((k) => ({
		idx: k,
		count: counts[k],
	}));
	if (entries.length === 0) return;

	const max = Math.max(...entries.map((e) => e.count));

	entries.forEach((e) => {
		const ti = info.textItems.find((t) => t.idx == e.idx);
		if (!ti) return;
		const r = ti.rect;
		const hl = document.createElement('div');
		hl.className = 'text-highlight';
		const intensity = e.count / max;
		hl.style.left = r.left + 'px';
		hl.style.top = r.top + 'px';
		hl.style.width = r.width + 'px';
		hl.style.height = r.height + 'px';
		hl.style.background = `rgba(250,180,50,${0.15 + 0.6 * intensity})`;
		info.overlay.appendChild(hl);
	});
}

function exportCSV() {
	if (!pdfDoc) {
		alert('No PDF loaded');
		return;
	}
	const rows = [];
	rows.push(['page', 'text', 'fixation_count', 'total_fixation_ms']);
	Object.keys(perPageHeatmaps).forEach((p) => {
		const pageNum = parseInt(p, 10);
		const info = perPageHeatmaps[pageNum];
		if (!info) return;
		const items = info.textItems || [];
		items.forEach((ti) => {
			const stat = info.textCounts[ti.idx] || { count: 0, duration: 0 };
			// sanitize text
			const txt = (ti.str || '').replace(/\r?\n|,|"/g, ' ').trim();
			rows.push([pageNum, `"${txt}"`, stat.count, stat.duration]);
		});
	});

	const csvContent = rows.map((r) => r.join(',')).join('\n');
	const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'eye_tracking_text_metrics.csv';
	document.body.appendChild(a);
	a.click();
	a.remove();
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

// Toggle showing/hiding text highlights
let textHighlightsEnabled = true;
function toggleTextHighlights() {
	textHighlightsEnabled = !textHighlightsEnabled;
	// show/hide all text-highlight overlays
	Object.values(perPageHeatmaps).forEach((info) => {
		if (!info) return;
		const overlays = info.overlay.querySelectorAll('.text-highlight');
		overlays.forEach(
			(el) => (el.style.display = textHighlightsEnabled ? 'block' : 'none')
		);
	});
	document.getElementById('toggleTextBtn').innerText = textHighlightsEnabled
		? 'Hide Text Highlights'
		: 'Show Text Highlights';
}

// Export heatmap + page canvas as PNG for a single page
async function exportPageHeatmap(pageNum) {
	const info = perPageHeatmaps[pageNum];
	if (!info) return;

	// find the page wrapper and pdf canvas
	const pageEl = document.querySelector(
		`.pdf-page[data-page-number='${pageNum}']`
	);
	if (!pageEl) return;
	const pdfCanvas = pageEl.querySelector('canvas.pdf-canvas');

	// create export canvas
	const exportCanvas = document.createElement('canvas');
	exportCanvas.width = info.width;
	exportCanvas.height = info.height;
	const ctx = exportCanvas.getContext('2d');

	// draw pdf page
	ctx.drawImage(pdfCanvas, 0, 0);

	// draw heatmap canvas (if present)
	const hmCanvas = info.overlay.querySelector('canvas');
	if (hmCanvas) ctx.drawImage(hmCanvas, 0, 0);

	// draw highlights
	const highlights = info.overlay.querySelectorAll('.text-highlight');
	highlights.forEach((hl) => {
		const left = parseFloat(hl.style.left) || 0;
		const top = parseFloat(hl.style.top) || 0;
		const w = parseFloat(hl.style.width) || 0;
		const h = parseFloat(hl.style.height) || 0;
		// get rgba from background style
		const bg = hl.style.background || 'rgba(250,180,50,0.25)';
		ctx.fillStyle = bg;
		ctx.fillRect(left, top, w, h);
	});

	// trigger download
	const url = exportCanvas.toDataURL('image/png');
	return url;
}

// Export all pages heatmaps sequentially
async function exportAllHeatmaps() {
	if (!pdfDoc) {
		alert('No PDF loaded');
		return;
	}
	// create zip with jszip
	const zip = new JSZip();
	for (let p = 1; p <= pdfDoc.numPages; p++) {
		const dataUrl = await exportPageHeatmap(p);
		if (!dataUrl) continue;
		// convert dataURL to blob
		const resp = await fetch(dataUrl);
		const blob = await resp.blob();
		zip.file(`page-${p}-heatmap.png`, blob);
	}
	// include CSV
	// build csv same as exportCSV but return content
	const rows = [];
	rows.push(['page', 'text', 'fixation_count', 'total_fixation_ms']);
	Object.keys(perPageHeatmaps).forEach((p) => {
		const pageNum = parseInt(p, 10);
		const info = perPageHeatmaps[pageNum];
		if (!info) return;
		const items = info.textItems || [];
		items.forEach((ti) => {
			const stat = info.textCounts[ti.idx] || { count: 0, duration: 0 };
			const txt = (ti.str || '').replace(/\r?\n|,|"/g, ' ').trim();
			rows.push([pageNum, `"${txt}"`, stat.count, stat.duration]);
		});
	});
	const csvContent = rows.map((r) => r.join(',')).join('\n');
	zip.file('eye_tracking_text_metrics.csv', csvContent);

	const content = await zip.generateAsync({ type: 'blob' });
	const url = URL.createObjectURL(content);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'eye-tracking-results.zip';
	document.body.appendChild(a);
	a.click();
	a.remove();
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
