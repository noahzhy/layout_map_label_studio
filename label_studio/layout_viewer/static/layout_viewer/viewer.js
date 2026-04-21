/**
 * Interactive Store Layout Viewer
 *
 * WebGL2 map renderer with split-pane image viewer, compass, timeline scrubber,
 * and dynamic camera density based on zoom level.
 *
 * Forked from point_cloud_editor/web/editor.js (read-only, no editing).
 */

// Map zoom limits (easy to tune)
const MAP_MIN_ZOOM = 0.1;
const MAP_MAX_ZOOM = 25.0;

// ============================================================================
// Shader Sources
// ============================================================================

const POINT_VERTEX_SHADER = `#version 300 es
precision highp float;

uniform mat3 u_viewMatrix;
uniform float u_pointSize;

in vec2 a_position;

void main() {
    vec3 pos = u_viewMatrix * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    gl_PointSize = u_pointSize;
}
`;

const POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 u_color;

out vec4 fragColor;

void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    if (length(coord) > 0.5) discard;
    fragColor = u_color;
}
`;

const CAMERA_VERTEX_SHADER = `#version 300 es
precision highp float;

uniform mat3 u_viewMatrix;
uniform float u_pointSize;

in vec2 a_position;
in vec4 a_color;

out vec4 v_color;

void main() {
    vec3 pos = u_viewMatrix * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    gl_PointSize = u_pointSize;
    v_color = a_color;
}
`;

const CAMERA_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);

    if (dist > 0.5) discard;

    if (dist > 0.35) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
        fragColor = v_color;
    }
}
`;

const LINE_VERTEX_SHADER = `#version 300 es
precision highp float;

uniform mat3 u_viewMatrix;

in vec2 a_position;

void main() {
    vec3 pos = u_viewMatrix * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
}
`;

const LINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 u_color;

out vec4 fragColor;

void main() {
    fragColor = u_color;
}
`;

// ============================================================================
// StoreLayoutViewer Class
// ============================================================================

class StoreLayoutViewer {
    constructor(canvas, compassCanvas, options = {}) {
        this.canvas = canvas;
        this.compassCanvas = compassCanvas;
        this.readOnly = !!options.readOnly;
        this.gl = canvas.getContext('webgl2', { antialias: true });

        if (!this.gl) {
            throw new Error('WebGL2 not supported');
        }

        // Data
        this.pointCloud = [];
        this.cameras = [];
        this.visibleCameras = [];
        this.overlayVisibleCameras = [];
        this.selectedCamera = null;
        this.hoveredCamera = null;
        this.metadata = null;
        this.mapAnnotations = [];
        this.cameraTimestamps = [];
        this.startTimestamp = null;

        // View state
        this.viewMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;

        // Smooth zoom animation
        this.zoomTarget = 1.0;
        this.zoomAnchorWorld = null;
        this.zoomAnchorScreen = null;
        this.isAnimatingZoom = false;

        // Smooth pan animation
        this.panTargetX = 0;
        this.panTargetY = 0;
        this.isAnimatingPan = false;

        // Interaction state
        this.isPanning = false;
        this.dragWorldAnchor = null;
        this.isAnimatingMapTransition = false;
        this.mapTargetZoom = 1.0;
        this.mapTargetPanX = 0;
        this.mapTargetPanY = 0;
        this.lastMapTransitionTime = 0;

        // Display options
        this.showPointCloud = true;
        this.showCameras = true;
        this.useCompassForMap = false;
        this.pointSize = 2;
        this.directionPixelsLength = 15.6;  // 30% longer than 12
        this.directionPixelsThickness = 6;   // 2X thicker than 3
        this.pathPixelsThickness = 4;

        // Image viewer state
        this.imageZoom = 1;
        this.imageOffsetX = 0;
        this.imageOffsetY = 0;
        this.imageZoomTarget = 1;
        this.imageOffsetXTarget = 0;
        this.imageOffsetYTarget = 0;
        this.isAnimatingImageView = false;
        this.lastImageViewTime = 0;
        this.imageBaseWidth = 0;
        this.imageBaseHeight = 0;
        this.isImageDragging = false;
        this.imageDragStart = { x: 0, y: 0 };
        this.imageDragOffset = { x: 0, y: 0 };

        // Image caching and preloading
        this.imageCache = new Map();
        this.imageCacheMaxSize = 20;
        this.mainImageLoading = false;
        this.activeMainImageName = null;
        this.pendingMainImageName = null;
        this.desiredMainImageName = null;
        this.preloadTimer = null;

        // Compass animation state
        this.compassDirection = null;
        this.compassTargetDirection = null;
        this.isAnimatingCompass = false;
        this.lastCompassTime = 0;

        // Timeline state
        this.isTimelineDragging = false;
        this.scrubIndex = -1;
        this.timelineThumbnailLoading = false;
        this.pendingTimelineThumbnail = null;

        // Playback state
        this.isPlaying = false;
        this.playbackTimer = null;
        this.playbackInterval = 300; // ms between frames

        // Map hover thumbnail state
        this.mapThumbnailLoading = false;
        this.pendingMapThumbnail = null;

        // People/face detection data for blur overlays
        this.detections = {};

        // Path configuration (for Label Studio integration)
        this.dataBaseUrl = options.dataBaseUrl || './';
        this.saveBaseUrl = options.saveBaseUrl || '';
        this.labelsYamlUrl = options.labelsYamlUrl || 'labels.yaml';

        // Per-image recognition/taxonomy data (from recognize_task.py)
        this.recogData = {};
        this.showRecogDetails = false;

        // Debug: OpenMVG match pairs
        this.matchPairs = [];
        this.trackPairs = [];
        this.matchAdjacency = new Map(); // cam_id -> Set of connected cam_ids
        this.trackAdjacency = new Map(); // cam_id -> Set of connected cam_ids
        this.showDebugMatches = false;
        this.debugConnectionSource = 'tracks';

        // Annotation mode state
        this.annotationMode = false;
        this.annotations = [];         // [{id, x, y, width, height, label}] in world coords
        this.rotationAngle = 0;        // cumulative rotation in degrees
        this.nextAnnotationId = 1;
        this.selectedAnnotation = null; // id of currently selected annotation box
        this.isDrawingBox = false;
        this.drawStartWorld = null;     // {x, y} world coords of box start
        this.drawCurrentWorld = null;   // {x, y} current mouse world coords
        this.configuredLabels = [];     // loaded from labels.yaml
        this.configuredLabelGroups = {}; // { groupName: [labels] } from labels.yaml
        this.configuredLabelGroupNames = []; // ordered group names
        this.categoryColorPalette = [
            '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
            '#FF00FF', '#00FFFF', '#FFA500', '#800080',
            '#008000', '#000080', '#808000', '#008080',
            '#FFC0CB', '#A52A2A', '#808080', '#FFD700'
        ];
        this.categoryColorAssignments = new Map();
        this.pendingBox = null;         // box awaiting label selection
        this.isDraggingAnnotation = false;
        this.dragAnnotationId = null;
        this.dragAnnotationOffset = null; // {dx, dy} offset from box origin to grab point
        this.hasUnsavedChanges = false;

        // Companion mode state
        this.companionMode = false;
        this.manualCompanions = [];     // manually added companion cameras
        this.nextManualCompanionId = 10000; // start IDs high to avoid collision

        // Calibration / scale bar state
        this.calibrationMode = false;
        this.calibrationPoints = [];    // [{x, y}] world coords, max 2
        this.baseRatio = null;          // real distance per world unit
        this.calibrationUnit = 'm';

        // Loaded data file name (for save-back)
        this.loadedDataFileName = null;

        // WebGL resources
        this.pointProgram = null;
        this.cameraProgram = null;
        this.lineProgram = null;
        this.pointBuffer = null;
        this.cameraBuffer = null;
        this.cameraColorBuffer = null;
        this.selectedCameraBuffer = null;
        this.selectedCameraColorBuffer = null;
        this.selectedDirectionBuffer = null;
        this.pathBuffer = null;
        this.directionBuffer = null;
        this.fovBuffer = null;
        this.selectedFovBuffer = null;
        this.overlayCameraBuffer = null;
        this.overlayColorBuffer = null;

        // Selected camera indicator animation (dot/direction/FOV)
        this.selectedIndicatorPose = null;
        this.selectedIndicatorTargetPose = null;
        this.isAnimatingSelectedIndicator = false;
        this.lastSelectedIndicatorTime = 0;

        // Animated pulse for special overlay markers
        this.hasOverlayCameras = false;
        this.isOverlayPulseAnimating = false;
        this.overlayPulseRaf = null;

        this.init();
    }

    init() {
        this.setupWebGL();
        this.setupEventListeners();
        this.loadLabelsConfig();
        this.resize();
        this.render();
        this.tryAutoLoad();
    }

    // ========================================================================
    // WebGL Setup
    // ========================================================================

    setupWebGL() {
        const gl = this.gl;

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.pointProgram = this.createProgram(POINT_VERTEX_SHADER, POINT_FRAGMENT_SHADER);
        this.cameraProgram = this.createProgram(CAMERA_VERTEX_SHADER, CAMERA_FRAGMENT_SHADER);
        this.lineProgram = this.createProgram(LINE_VERTEX_SHADER, LINE_FRAGMENT_SHADER);

        this.pointBuffer = gl.createBuffer();
        this.cameraBuffer = gl.createBuffer();
        this.cameraColorBuffer = gl.createBuffer();
        this.selectedCameraBuffer = gl.createBuffer();
        this.selectedCameraColorBuffer = gl.createBuffer();
        this.selectedDirectionBuffer = gl.createBuffer();
        this.pathBuffer = gl.createBuffer();
        this.directionBuffer = gl.createBuffer();
        this.fovBuffer = gl.createBuffer();
        this.selectedFovBuffer = gl.createBuffer();
        this.overlayCameraBuffer = gl.createBuffer();
        this.overlayColorBuffer = gl.createBuffer();
        this.matchLineBuffer = gl.createBuffer();
    }

    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    createProgram(vertexSource, fragmentSource) {
        const gl = this.gl;
        const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentSource);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
            return null;
        }

        return program;
    }

    // ========================================================================
    // Data Loading
    // ========================================================================

    /**
     * Resolve a relative base path by prepending dataBaseUrl if needed.
     * Full URLs (http/https) are returned as-is.
     */
    _resolveBasePath(path) {
        if (/^https?:\/\//i.test(path)) return path;
        if (path.startsWith('/')) return path;
        return this.dataBaseUrl + path;
    }

    async fetchGzippedJson(url) {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Failed to load ${url}: ${resp.status}`);
        }

        const bytes = new Uint8Array(await resp.arrayBuffer());
        const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

        // Some servers auto-decompress .gz based on headers. Accept either raw gzip bytes
        // or already-decoded JSON bytes, but only from the .json.gz path.
        if (!isGzip) {
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        }
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('This browser does not support DecompressionStream(gzip).');
        }

        const compressedStream = new Blob([bytes]).stream();
        const decompressedStream = compressedStream.pipeThrough(new DecompressionStream('gzip'));
        return await new Response(decompressedStream).json();
    }

    async tryAutoLoad() {
        const base = this.dataBaseUrl;
        try {
            // Find the newest viewer_*.json.gz file by Last-Modified time
            let dataUrl = base + 'viewer_label.json.gz';
            try {
                const listResp = await fetch(base);
                if (listResp.ok) {
                    const text = await listResp.text();
                    const matches = text.match(/viewer_.*?\.json\.gz/g);
                    if (matches && matches.length > 0) {
                        const taskFiles = [...new Set(matches)].filter(f => f !== 'viewer_label.json.gz');

                        if (taskFiles.length > 0) {
                            taskFiles.sort().reverse();
                            dataUrl = base + taskFiles[0];
                        } else {
                            dataUrl = base + 'viewer_label.json.gz'; // 只有没找到任务文件时才用默认的
                        }
                    }
                }
            } catch (_) { /* listing not available, use default */ }

            this.loadedDataFileName = dataUrl.split('/').pop();
            const data = await this.fetchGzippedJson(dataUrl);
            this.loadData(data);
            this.handleUrlParams();
        } catch (e) {
            // Auto-load failed, user can use file picker
        }

        // Load detection bounding boxes for blur overlays
        try {
            const dData = await this.fetchGzippedJson(base + 'detections.json.gz');
            this.detections = dData.images || {};
        } catch (e) {
            // No detections available
        }
    }

    handleUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const camParam = params.get('cam');
        if (camParam !== null) {
            const camId = parseInt(camParam, 10);
            if (!isNaN(camId) && camId >= 0 && camId < this.cameras.length) {
                this.selectCamera(camId);
            }
        }
    }

    loadData(data) {
        this.pointCloud = data.pointCloud || [];
        this.cameras = data.cameras || [];
        this.mapAnnotations = data.mapAnnotations || [];
        this.metadata = data.metadata || {};
        this.selectedCamera = null;
        this.hoveredCamera = null;

        // Load saved annotations and rotation state
        if (Array.isArray(data.annotations)) {
            this.annotations = data.annotations.map(a => ({ ...a }));
            this.nextAnnotationId = this.annotations.reduce((max, a) => Math.max(max, (a.id || 0) + 1), 1);
        }
        if (typeof data.rotationApplied === 'number') {
            this.rotationAngle = data.rotationApplied;
        }

        // Restore manual companion tracking from loaded cameras
        this.manualCompanions = this.cameras.filter(c => c.isManualCompanion);
        if (this.manualCompanions.length > 0) {
            this.nextManualCompanionId = this.manualCompanions.reduce(
                (max, c) => Math.max(max, (c.id || 0) + 1), this.nextManualCompanionId
            );
        }

        this.hasUnsavedChanges = false;
        this.syncRotationSlider();

        const storeName = this.metadata.storeName ? String(this.metadata.storeName).trim() : '';
        document.title = storeName ? `${storeName} - Store Layout Viewer` : 'Store Layout Viewer';

        const compassDirLabel = document.getElementById('compassDirLabel');
        if (compassDirLabel) {
            const showCompassToggle = Boolean(this.metadata && this.metadata.showCompassDirToggle);
            compassDirLabel.style.display = showCompassToggle ? '' : 'none';
            if (!showCompassToggle) {
                this.useCompassForMap = false;
                const compassCheckbox = document.getElementById('useCompassForMap');
                if (compassCheckbox) {
                    compassCheckbox.checked = false;
                }
            }
        }

        // Use timestamp metadata from JSON (do not parse from filenames in browser).
        this.cameraTimestamps = this.cameras.map(c => {
            const ts = Number(c.timestampMs);
            return Number.isFinite(ts) ? ts : null;
        });
        this.startTimestamp = this.cameraTimestamps.find(t => t !== null) || null;

        // Update store info display
        if (this.metadata.storeName) {
            document.getElementById('storeName').textContent = this.metadata.storeName;
        }
        if (this.metadata.storeAddress) {
            document.getElementById('storeAddress').textContent = this.metadata.storeAddress;
        }

        // Load OpenMVG filtered match pairs if present
        this.matchPairs = data.matchPairs || [];
        this.matchAdjacency = new Map();
        for (const [a, b] of this.matchPairs) {
            if (!this.matchAdjacency.has(a)) this.matchAdjacency.set(a, new Set());
            if (!this.matchAdjacency.has(b)) this.matchAdjacency.set(b, new Set());
            this.matchAdjacency.get(a).add(b);
            this.matchAdjacency.get(b).add(a);
        }

        // Load track-derived pair connections if present
        this.trackPairs = data.trackPairs || [];
        this.trackAdjacency = new Map();
        for (const [a, b] of this.trackPairs) {
            if (!this.trackAdjacency.has(a)) this.trackAdjacency.set(a, new Set());
            if (!this.trackAdjacency.has(b)) this.trackAdjacency.set(b, new Set());
            this.trackAdjacency.get(a).add(b);
            this.trackAdjacency.get(b).add(a);
        }

        // Load recognition taxonomy data if present
        this.recogData = data.recogData || {};
        const recogDetailsLabel = document.getElementById('recogDetailsLabel');
        if (recogDetailsLabel) {
            recogDetailsLabel.style.display = Object.keys(this.recogData).length > 0 ? '' : 'none';
        }

        // Show debug controls only when any connection data exists
        const debugLabel = document.getElementById('debugLabel');
        const debugSourceLabel = document.getElementById('debugSourceLabel');
        const hasMatches = this.matchPairs.length > 0;
        const hasTracks = this.trackPairs.length > 0;
        const hasAnyConnections = hasMatches || hasTracks;
        if (debugLabel) {
            debugLabel.style.display = hasAnyConnections ? '' : 'none';
        }
        if (debugSourceLabel) {
            debugSourceLabel.style.display = hasAnyConnections ? '' : 'none';
        }

        const sourceSelect = document.getElementById('debugSourceSelect');
        if (sourceSelect) {
            // Keep selected source valid for the currently loaded data.
            if (this.debugConnectionSource === 'tracks' && !hasTracks) {
                this.debugConnectionSource = hasMatches ? 'matches' : 'tracks';
            } else if (this.debugConnectionSource === 'matches' && !hasMatches) {
                this.debugConnectionSource = hasTracks ? 'tracks' : 'matches';
            }
            sourceSelect.value = this.debugConnectionSource;
            const matchesOpt = sourceSelect.querySelector('option[value="matches"]');
            const tracksOpt = sourceSelect.querySelector('option[value="tracks"]');
            if (matchesOpt) matchesOpt.disabled = !hasMatches;
            if (tracksOpt) tracksOpt.disabled = !hasTracks;
        }

        this.uploadPointCloud();
        this.updateVisibleCameras();
        this.hasOverlayCameras = this.cameras.some(c => c.isOverlay);
        this.updateOverlayPulseAnimationState();
        this.fitView();
        this.render();
        this.renderMapLegend();
        this.restoreCalibration(data);
    }

    updateOverlayPulseAnimationState() {
        if (this.hasOverlayCameras) {
            if (!this.isOverlayPulseAnimating) {
                this.isOverlayPulseAnimating = true;
                this.overlayPulseRaf = requestAnimationFrame(() => this.animateOverlayPulse());
            }
            return;
        }

        this.isOverlayPulseAnimating = false;
        if (this.overlayPulseRaf !== null) {
            cancelAnimationFrame(this.overlayPulseRaf);
            this.overlayPulseRaf = null;
        }
    }

    animateOverlayPulse() {
        if (!this.isOverlayPulseAnimating) return;
        this.render();
        this.overlayPulseRaf = requestAnimationFrame(() => this.animateOverlayPulse());
    }

    uploadPointCloud() {
        const gl = this.gl;
        const data = new Float32Array(this.pointCloud.flat());

        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }

    getCameraById(cameraId) {
        return this.cameras.find(c => c.id === cameraId) || null;
    }

    getNavigationCameras() {
        // Navigation order excludes special overlay markers.
        return this.cameras.filter(c => !c.isOverlay);
    }

    getAssociatedBaseCameraId(cameraId) {
        const cam = this.getCameraById(cameraId);
        if (!cam || !cam.isOverlay) return null;

        const associatedId = Number(cam.associatedCameraId);
        if (!Number.isFinite(associatedId)) return null;

        const associatedCam = this.getCameraById(associatedId);
        return associatedCam && !associatedCam.isOverlay ? associatedCam.id : null;
    }

    getCameraPose(cameraId) {
        const cam = this.getCameraById(cameraId);
        if (!cam) return null;
        return {
            x: cam.position[0],
            y: cam.position[1],
            direction: this.getMapDirection(cam),
        };
    }

    getMapDirection(cam) {
        if (
            this.useCompassForMap &&
            cam &&
            cam.compassDirection !== undefined &&
            cam.compassDirection !== null
        ) {
            return cam.compassDirection;
        }
        return cam.direction;
    }

    getCameraLabel(cam) {
        if (!cam) return '';
        if (typeof cam.title === 'string' && cam.title.trim().length > 0) {
            return cam.title.trim();
        }
        return cam.imageName || '';
    }

    getThumbnailCaption(cam) {
        if (!cam) return '';
        if (!cam.isOverlay) {
            const elapsed = this.getElapsedMs(cam.id);
            return this.formatElapsedFixed(elapsed) || cam.imageName;
        }
        return this.getCameraLabel(cam) || this.formatElapsedFixed(this.getElapsedMs(cam.id)) || cam.imageName;
    }

    getCameraRecog(cam) {
        if (!cam || !cam.imageName) return null;
        const stem = cam.imageName.replace(/\.[^.]+$/, '');
        return this.recogData[stem] || null;
    }

    /** Return { depts: string[], cats: string[], entries: object[] } or null.
     *  Excludes center-aisle entries for thumbnail popups. */
    getRecogSummary(cam) {
        const all = this.getCameraRecog(cam);
        if (!all || !all.length) return null;
        const entries = all.filter(e => (e.shelf_position || '') !== 'center');
        if (!entries.length) return null;
        const depts = [...new Set(entries.map(e => e.department).filter(Boolean))];
        const cats = [...new Set(entries.map(e => e.category).filter(Boolean))];
        return { depts, cats, entries };
    }

    /** Render recognition tags into a container element. */
    _renderRecogTags(container, summary) {
        container.innerHTML = '';
        if (!summary) return;
        for (const d of summary.depts) {
            const tag = document.createElement('span');
            tag.className = 'recog-tag recog-tag-dept';
            tag.textContent = d.replace(/_/g, ' ');
            container.appendChild(tag);
        }
        for (const c of summary.cats) {
            const tag = document.createElement('span');
            tag.className = 'recog-tag recog-tag-cat';
            tag.textContent = c.replace(/_/g, ' ');
            container.appendChild(tag);
        }
    }

    /** Deduplicate entries by (dept, cat, subcat, brands, products). */
    _deduplicateRecogEntries(entries) {
        const seen = new Set();
        return entries.filter(entry => {
            const key = [
                entry.department || '',
                entry.category || '',
                entry.subcategory || '',
                (entry.brands || []).slice().sort().join('|'),
                (entry.products || []).slice().sort().join('|'),
            ].join('\0');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /** Build one column (left or right) of the recog bar. */
    _buildRecogCol(entries, side) {
        if (!entries.length) return null;

        const col = document.createElement('div');
        col.className = `recog-col recog-col-${side}`;

        // Summary tags row
        const depts = [...new Set(entries.map(e => e.department).filter(Boolean))];
        const cats = [...new Set(entries.map(e => e.category).filter(Boolean))];
        const summaryRow = document.createElement('div');
        summaryRow.className = 'recog-summary-row';
        this._renderRecogTags(summaryRow, { depts, cats });
        col.appendChild(summaryRow);

        // Details list
        if (this.showRecogDetails) {
            const unique = this._deduplicateRecogEntries(entries);
            if (unique.length) {
                const detailsList = document.createElement('div');
                detailsList.className = 'recog-details-list';
                for (const entry of unique) {
                    const parts = [entry.department, entry.category, entry.subcategory]
                        .filter(Boolean).map(s => s.replace(/_/g, ' '));
                    const path = parts.join(' › ');
                    const brands = (entry.brands || []).join(', ');
                    const products = (entry.products || []).join(', ');
                    const itemLine = [brands, products].filter(Boolean).join(' · ');
                    const row = document.createElement('div');
                    row.className = 'recog-detail-entry';
                    row.innerHTML = `<span class="recog-detail-path">${path}</span>`
                        + (itemLine ? `<span class="recog-detail-items">: ${itemLine}</span>` : '');
                    detailsList.appendChild(row);
                }
                col.appendChild(detailsList);
            }
        }

        return col;
    }

    updateImageRecogBar(cam) {
        const bar = document.getElementById('imageRecogBar');
        if (!bar) return;

        const all = cam ? (this.getCameraRecog(cam) || []) : [];
        const leftEntries  = all.filter(e => (e.shelf_position || '') === 'left');
        const rightEntries = all.filter(e => (e.shelf_position || '') === 'right');
        // center entries are intentionally excluded

        if (!leftEntries.length && !rightEntries.length) {
            bar.innerHTML = '';
            bar.classList.remove('visible');
            return;
        }

        bar.innerHTML = '';
        bar.classList.add('visible');

        const leftCol  = this._buildRecogCol(leftEntries, 'left');
        const rightCol = this._buildRecogCol(rightEntries, 'right');
        if (leftCol)  bar.appendChild(leftCol);
        if (rightCol) bar.appendChild(rightCol);
    }

    startSelectedIndicatorTransition(previousId, nextId, animate) {
        const targetPose = this.getCameraPose(nextId);
        if (!targetPose) return;

        if (!animate || previousId === null || previousId === nextId) {
            this.selectedIndicatorPose = { ...targetPose };
            this.selectedIndicatorTargetPose = { ...targetPose };
            this.isAnimatingSelectedIndicator = false;
            return;
        }

        const startPose = this.selectedIndicatorPose || this.getCameraPose(previousId) || targetPose;
        this.selectedIndicatorPose = { ...startPose };
        this.selectedIndicatorTargetPose = { ...targetPose };

        if (!this.isAnimatingSelectedIndicator) {
            this.isAnimatingSelectedIndicator = true;
            this.lastSelectedIndicatorTime = performance.now();
            requestAnimationFrame(() => this.animateSelectedIndicator());
        }
    }

    animateSelectedIndicator() {
        if (
            !this.isAnimatingSelectedIndicator ||
            !this.selectedIndicatorPose ||
            !this.selectedIndicatorTargetPose
        ) {
            return;
        }

        const now = performance.now();
        const dt = Math.min((now - this.lastSelectedIndicatorTime) / 1000, 0.05);
        this.lastSelectedIndicatorTime = now;

        const pose = this.selectedIndicatorPose;
        const target = this.selectedIndicatorTargetPose;
        const dx = target.x - pose.x;
        const dy = target.y - pose.y;
        const dDir = ((target.direction - pose.direction + 540) % 360) - 180;
        const done = Math.hypot(dx, dy) < 0.2 && Math.abs(dDir) < 0.3;

        if (done) {
            this.selectedIndicatorPose = { ...target };
            this.isAnimatingSelectedIndicator = false;
            this.updateVisibleCameras();
            this.render();
            return;
        }

        const lerpFactor = 1 - Math.exp(-16 * dt);
        pose.x += dx * lerpFactor;
        pose.y += dy * lerpFactor;
        pose.direction = (pose.direction + dDir * lerpFactor + 360) % 360;
        this.selectedIndicatorPose = pose;
        this.render();
        requestAnimationFrame(() => this.animateSelectedIndicator());
    }

    setSelectedCameraState(cameraId, animateIndicator) {
        const previous = this.selectedCamera;
        this.selectedCamera = cameraId;
        this.startSelectedIndicatorTransition(previous, cameraId, animateIndicator);
        this.updateVisibleCameras();
        this.updateFOVWedge();
        this.updateMatchLines();
    }

    getElapsedMs(cameraId) {
        if (this.startTimestamp === null) return null;
        const idx = this.cameras.findIndex(c => c.id === cameraId);
        if (idx < 0) return null;
        const ts = this.cameraTimestamps[idx];
        if (ts === null) return null;
        return ts - this.startTimestamp;
    }

    formatElapsed(ms) {
        if (ms === null || ms === undefined) return '';
        const totalTenths = Math.round(Math.abs(ms) / 100);
        const h = Math.floor(totalTenths / 36000);
        const m = Math.floor((totalTenths % 36000) / 600);
        const s = Math.floor((totalTenths % 600) / 10);
        const t = totalTenths % 10;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t}`;
        return `${m}:${String(s).padStart(2, '0')}.${t}`;
    }

    formatElapsedFixed(ms) {
        if (ms === null || ms === undefined) return '';
        const totalTenths = Math.round(Math.abs(ms) / 100);
        const h = Math.floor(totalTenths / 36000);
        const m = Math.floor((totalTenths % 36000) / 600);
        const s = Math.floor((totalTenths % 600) / 10);
        const t = totalTenths % 10;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t}`;
    }

    formatDateTime(ts) {
        if (ts === null || ts === undefined) return '';
        const roundedTs = Math.round(ts / 100) * 100;
        const d = new Date(roundedTs);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const tenth = Math.floor(d.getMilliseconds() / 100);
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${tenth}`;
    }

    formatDateTimeLocal(dateTimeLocal) {
        if (!dateTimeLocal || typeof dateTimeLocal !== 'string') return '';
        const match = dateTimeLocal.match(
            /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/
        );
        if (!match) return dateTimeLocal;

        const [_, y, mo, d, h, mi, s, msRaw] = match;
        const ms = parseInt(msRaw.padEnd(3, '0').slice(0, 3), 10);
        const dt = new Date(+y, +mo - 1, +d, +h, +mi, +s, ms);
        const roundedTs = Math.round(dt.getTime() / 100) * 100;
        return this.formatDateTime(roundedTs);
    }

    // ========================================================================
    // Dynamic Camera Density
    // ========================================================================

    getVisibleCameras() {
        const targetMinScreenPixels = 36;
        const minWorldDist = targetMinScreenPixels / this.zoom;
        const baseCameras = this.cameras.filter(c => !c.isOverlay);
        const overlayCameras = this.cameras.filter(c => c.isOverlay);

        const visible = [];
        let lastKept = null;

        for (const cam of baseCameras) {
            if (lastKept === null || this.worldDist(cam.position, lastKept.position) >= minWorldDist) {
                visible.push(cam);
                lastKept = cam;
            }
        }

        // Always include selected camera
        if (this.selectedCamera !== null) {
            const sel = this.cameras.find(c => c.id === this.selectedCamera);
            if (sel && !visible.find(c => c.id === sel.id)) {
                let inserted = false;
                for (let i = 0; i < visible.length; i++) {
                    if (visible[i].imageName > sel.imageName) {
                        visible.splice(i, 0, sel);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) visible.push(sel);
            }
        }

        // Always include hovered camera
        if (this.hoveredCamera !== null) {
            const hov = this.cameras.find(c => c.id === this.hoveredCamera);
            if (hov && !visible.find(c => c.id === hov.id)) {
                let inserted = false;
                for (let i = 0; i < visible.length; i++) {
                    if (visible[i].imageName > hov.imageName) {
                        visible.splice(i, 0, hov);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) visible.push(hov);
            }
        }

        // Keep all overlay markers visible regardless of dynamic downsampling.
        for (const overlay of overlayCameras) {
            if (!visible.find(c => c.id === overlay.id)) {
                visible.push(overlay);
            }
        }

        return visible;
    }

    worldDist(a, b) {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    updateVisibleCameras() {
        this.visibleCameras = this.getVisibleCameras();
        this.uploadVisibleCameras();
        this.updatePathLine();
    }

    uploadVisibleCameras() {
        const gl = this.gl;
        const cams = this.visibleCameras;
        const hoveredId = this.hoveredCamera;
        const selectedId = this.selectedCamera;
        const suppressSelectedBase = this.isAnimatingSelectedIndicator;

        // Draw order matters in WebGL point rendering. Keep highlighted cameras last
        // so they always appear on top of non-highlighted cameras.
        const camsDrawOrder = [...cams].sort((a, b) => {
            const rank = (cam) => {
                if (hoveredId !== null && cam.id === hoveredId) return 2;
                if (selectedId !== null && cam.id === selectedId) return 1;
                return 0;
            };
            return rank(a) - rank(b);
        });

        // Positions
        const positions = new Float32Array(camsDrawOrder.flatMap(c => c.position));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

        // Colors -- all cameras same base color, only selected/hovered differ
        const colors = new Float32Array(camsDrawOrder.flatMap(c => {
            if (this.hoveredCamera === c.id) {
                return [0.965, 0.831, 0.278, 1.0]; // Yellow - hovered
            } else if (this.selectedCamera === c.id && !suppressSelectedBase) {
                return [0.965, 0.831, 0.278, 1.0]; // Yellow - selected
            } else if (c.isOverlay) {
                return [0.98, 0.45, 0.18, 1.0]; // Orange - special overlay point
            } else {
                return [0.086, 0.239, 0.545, 1.0]; // Dark blue - normal
            }
        }));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);

        // Overlay marker positions for animated pulse rendering.
        this.overlayVisibleCameras = camsDrawOrder.filter(c => c.isOverlay);
        if (this.overlayVisibleCameras.length > 0) {
            const overlayPositions = new Float32Array(
                this.overlayVisibleCameras.flatMap(c => c.position)
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCameraBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, overlayPositions, gl.DYNAMIC_DRAW);
        }

        this.updateDirectionBuffer();
    }

    // ========================================================================
    // Path Line (straight segments through visible cameras)
    // ========================================================================

    updatePathLine() {
        const gl = this.gl;
        const cams = this.visibleCameras.filter(c => !c.isOverlay);

        if (cams.length < 2) {
            this.pathVertexCount = 0;
            return;
        }

        const halfThickness = (this.pathPixelsThickness / this.zoom) / 2;
        const pathTriangles = [];

        for (let i = 0; i < cams.length - 1; i++) {
            const [x0, y0] = cams[i].position;
            const [x1, y1] = cams[i + 1].position;
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len === 0) continue;

            const nx = -dy / len * halfThickness;
            const ny = dx / len * halfThickness;

            pathTriangles.push(
                x0 + nx, y0 + ny,
                x0 - nx, y0 - ny,
                x1 - nx, y1 - ny,
                x0 + nx, y0 + ny,
                x1 - nx, y1 - ny,
                x1 + nx, y1 + ny
            );
        }

        if (pathTriangles.length === 0) {
            this.pathVertexCount = 0;
            return;
        }

        const data = new Float32Array(pathTriangles);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.pathVertexCount = pathTriangles.length / 2;
    }

    // ========================================================================
    // Direction Indicators
    // ========================================================================

    updateDirectionBuffer() {
        const directionCameras = this.visibleCameras.filter(c => !c.isOverlay);
        if (!this.gl || directionCameras.length === 0) {
            this.directionVertexCount = 0;
            return;
        }

        const dirLength = this.directionPixelsLength / this.zoom;
        const dirThickness = this.directionPixelsThickness / this.zoom;
        const radius = dirThickness / 2;
        const circleSegments = 12;
        const dirTriangles = [];

        for (const cam of directionCameras) {
            const rad = this.getMapDirection(cam) * Math.PI / 180;
            const ux = Math.sin(rad);
            const uy = -Math.cos(rad);
            const dx = dirLength * ux;
            const dy = dirLength * uy;
            const px = -uy * radius;
            const py = ux * radius;

            const startX = cam.position[0];
            const startY = cam.position[1];
            const endX = startX + dx;
            const endY = startY + dy;

            if (dirLength <= 2 * radius) {
                // Extremely short vectors degenerate to a circle.
                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;
                this.pushCircleTriangles(dirTriangles, midX, midY, radius, circleSegments);
                continue;
            }

            // Core rectangle (with round caps added below) forms a capsule.
            const coreStartX = startX + ux * radius;
            const coreStartY = startY + uy * radius;
            const coreEndX = endX - ux * radius;
            const coreEndY = endY - uy * radius;

            dirTriangles.push(
                coreStartX + px, coreStartY + py,
                coreStartX - px, coreStartY - py,
                coreEndX - px, coreEndY - py,
                coreStartX + px, coreStartY + py,
                coreEndX - px, coreEndY - py,
                coreEndX + px, coreEndY + py
            );

            this.pushCircleTriangles(dirTriangles, startX, startY, radius, circleSegments);
            this.pushCircleTriangles(dirTriangles, endX, endY, radius, circleSegments);
        }

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.directionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dirTriangles), gl.DYNAMIC_DRAW);
        this.directionVertexCount = dirTriangles.length / 2;
    }

    pushCircleTriangles(output, cx, cy, radius, segments) {
        if (radius <= 0 || segments < 3) return;
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;
            output.push(
                cx, cy,
                cx + radius * Math.cos(a0), cy + radius * Math.sin(a0),
                cx + radius * Math.cos(a1), cy + radius * Math.sin(a1)
            );
        }
    }

    // ========================================================================
    // FOV Wedge
    // ========================================================================

    updateFOVWedge() {
        const gl = this.gl;

        if (this.selectedCamera === null) {
            this.fovVertexCount = 0;
            return;
        }

        const cam = this.cameras.find(c => c.id === this.selectedCamera);
        if (!cam) {
            this.fovVertexCount = 0;
            return;
        }

        const hfov = (this.metadata && this.metadata.hfov) || 104;
        const halfFov = hfov / 2;
        const wedgeLength = 40 / this.zoom;

        const centerDir = this.getMapDirection(cam);
        const startAngle = centerDir - halfFov;
        const endAngle = centerDir + halfFov;
        const steps = 32;

        const cx = cam.position[0];
        const cy = cam.position[1];
        const verts = [];

        for (let i = 0; i < steps; i++) {
            const a0 = (startAngle + (endAngle - startAngle) * i / steps) * Math.PI / 180;
            const a1 = (startAngle + (endAngle - startAngle) * (i + 1) / steps) * Math.PI / 180;

            verts.push(cx, cy);
            verts.push(cx + wedgeLength * Math.sin(a0), cy - wedgeLength * Math.cos(a0));
            verts.push(cx + wedgeLength * Math.sin(a1), cy - wedgeLength * Math.cos(a1));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.fovBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        this.fovVertexCount = verts.length / 2;
    }

    // ========================================================================
    // Debug Match Lines
    // ========================================================================

    updateMatchLines() {
        this.matchLineVertexCount = 0;
        if (!this.showDebugMatches || this.selectedCamera === null) return;

        const adjacency =
            this.debugConnectionSource === 'tracks'
                ? this.trackAdjacency
                : this.matchAdjacency;
        const neighbors = adjacency.get(this.selectedCamera);
        if (!neighbors || neighbors.size === 0) return;

        const selCam = this.cameras.find(c => c.id === this.selectedCamera);
        if (!selCam) return;

        const halfThickness = (2 / this.zoom) / 2;
        const triangles = [];

        for (const neighborId of neighbors) {
            const nbCam = this.cameras.find(c => c.id === neighborId);
            if (!nbCam) continue;

            const [x0, y0] = selCam.position;
            const [x1, y1] = nbCam.position;
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len === 0) continue;

            const nx = -dy / len * halfThickness;
            const ny = dx / len * halfThickness;

            triangles.push(
                x0 + nx, y0 + ny,
                x0 - nx, y0 - ny,
                x1 - nx, y1 - ny,
                x0 + nx, y0 + ny,
                x1 - nx, y1 - ny,
                x1 + nx, y1 + ny
            );
        }

        if (triangles.length === 0) return;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.matchLineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.DYNAMIC_DRAW);
        this.matchLineVertexCount = triangles.length / 2;
    }

    renderMatchLines() {
        if (!this.matchLineVertexCount) return;

        const gl = this.gl;
        gl.useProgram(this.lineProgram);

        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.0, 0.75, 0.35, 0.7);

        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.matchLineBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.matchLineVertexCount);
    }

    // ========================================================================
    // View Controls
    // ========================================================================

    computeFitViewState() {
        if (this.cameras.length === 0 && this.pointCloud.length === 0) return null;
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const cam of this.cameras) {
            minX = Math.min(minX, cam.position[0]);
            minY = Math.min(minY, cam.position[1]);
            maxX = Math.max(maxX, cam.position[0]);
            maxY = Math.max(maxY, cam.position[1]);
        }

        for (const pt of this.pointCloud) {
            minX = Math.min(minX, pt[0]);
            minY = Math.min(minY, pt[1]);
            maxX = Math.max(maxX, pt[0]);
            maxY = Math.max(maxY, pt[1]);
        }

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const width = maxX - minX;
        const height = maxY - minY;

        const boundedWidth = Math.max(width, 1);
        const boundedHeight = Math.max(height, 1);
        const zoomX = this.canvas.width / boundedWidth;
        const zoomY = this.canvas.height / boundedHeight;
        const zoom = Math.min(zoomX, zoomY, 12.5);
        return {
            zoom,
            panX: -centerX,
            panY: -centerY,
        };
    }

    getDataBoundsWorld() {
        if (this.cameras.length === 0 && this.pointCloud.length === 0) return null;
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const cam of this.cameras) {
            minX = Math.min(minX, cam.position[0]);
            minY = Math.min(minY, cam.position[1]);
            maxX = Math.max(maxX, cam.position[0]);
            maxY = Math.max(maxY, cam.position[1]);
        }
        for (const pt of this.pointCloud) {
            minX = Math.min(minX, pt[0]);
            minY = Math.min(minY, pt[1]);
            maxX = Math.max(maxX, pt[0]);
            maxY = Math.max(maxY, pt[1]);
        }

        return { minX, minY, maxX, maxY };
    }

    clampPanToDataBounds(panX, panY, zoom = this.zoom) {
        const bounds = this.getDataBoundsWorld();
        if (!bounds || this.canvas.width <= 0 || this.canvas.height <= 0 || zoom <= 0) {
            return { panX, panY };
        }

        const halfW = this.canvas.width / (2 * zoom);
        const halfH = this.canvas.height / (2 * zoom);
        const dataW = bounds.maxX - bounds.minX;
        const dataH = bounds.maxY - bounds.minY;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;

        let clampedPanX = panX;
        let clampedPanY = panY;

        // When data span is larger than viewport span, clamp to avoid border whitespace.
        // When data span is smaller, keep centered.
        if (dataW > 2 * halfW) {
            const minPanX = -(bounds.maxX - halfW);
            const maxPanX = -(bounds.minX + halfW);
            clampedPanX = Math.max(minPanX, Math.min(maxPanX, panX));
        } else {
            clampedPanX = -centerX;
        }

        if (dataH > 2 * halfH) {
            const minPanY = -(bounds.maxY - halfH);
            const maxPanY = -(bounds.minY + halfH);
            clampedPanY = Math.max(minPanY, Math.min(maxPanY, panY));
        } else {
            clampedPanY = -centerY;
        }

        return { panX: clampedPanX, panY: clampedPanY };
    }

    fitView() {
        const fit = this.computeFitViewState();
        if (!fit) return;

        this.zoom = fit.zoom;
        this.zoomTarget = this.zoom;
        this.panX = fit.panX;
        this.panY = fit.panY;
        this.panTargetX = this.panX;
        this.panTargetY = this.panY;

        this.updateViewMatrix();
        this.updateVisibleCameras();
    }

    smoothFitView() {
        const fit = this.computeFitViewState();
        if (!fit) return;
        this.startMapTransition(fit.zoom, fit.panX, fit.panY);
    }

    startMapTransition(targetZoom, targetPanX, targetPanY) {
        this.mapTargetZoom = targetZoom;
        this.mapTargetPanX = targetPanX;
        this.mapTargetPanY = targetPanY;
        if (!this.isAnimatingMapTransition) {
            this.isAnimatingMapTransition = true;
            this.lastMapTransitionTime = performance.now();
            requestAnimationFrame(() => this.animateMapTransition());
        }
    }

    animateMapTransition() {
        if (!this.isAnimatingMapTransition) return;

        const now = performance.now();
        const dt = Math.min((now - this.lastMapTransitionTime) / 1000, 0.05);
        this.lastMapTransitionTime = now;

        const zoomErr = this.mapTargetZoom - this.zoom;
        const panXErr = this.mapTargetPanX - this.panX;
        const panYErr = this.mapTargetPanY - this.panY;
        const done = Math.abs(zoomErr) < 0.002 && Math.abs(panXErr) < 0.2 && Math.abs(panYErr) < 0.2;

        if (done) {
            this.zoom = this.mapTargetZoom;
            this.zoomTarget = this.zoom;
            this.panX = this.mapTargetPanX;
            this.panY = this.mapTargetPanY;
            this.panTargetX = this.panX;
            this.panTargetY = this.panY;
            this.updateViewMatrix();
            this.updateVisibleCameras();
            this.render();
            this.isAnimatingMapTransition = false;
            return;
        }

        const lerpFactor = 1 - Math.exp(-12 * dt);
        this.zoom += zoomErr * lerpFactor;
        this.panX += panXErr * lerpFactor;
        this.panY += panYErr * lerpFactor;

        this.updateViewMatrix();
        this.updateVisibleCameras();
        this.render();

        requestAnimationFrame(() => this.animateMapTransition());
    }

    areAllDataWithinCanvas(zoom = this.zoom, panX = this.panX, panY = this.panY) {
        const hasData = this.cameras.length > 0 || this.pointCloud.length > 0;
        if (!hasData || this.canvas.width <= 0 || this.canvas.height <= 0) return true;

        const scaleX = zoom * 2 / this.canvas.width;
        const scaleY = -zoom * 2 / this.canvas.height;
        const epsilon = 1e-6;

        const inBounds = (point) => {
            const ndcX = (point[0] + panX) * scaleX;
            const ndcY = (point[1] + panY) * scaleY;
            return (
                ndcX >= -1 - epsilon &&
                ndcX <= 1 + epsilon &&
                ndcY >= -1 - epsilon &&
                ndcY <= 1 + epsilon
            );
        };

        for (const cam of this.cameras) {
            if (!inBounds(cam.position)) return false;
        }
        for (const pt of this.pointCloud) {
            if (!inBounds(pt)) return false;
        }
        return true;
    }

    updateViewMatrix() {
        const scaleX = this.zoom * 2 / this.canvas.width;
        const scaleY = -this.zoom * 2 / this.canvas.height;

        this.viewMatrix = [
            scaleX, 0, 0,
            0, scaleY, 0,
            this.panX * scaleX, this.panY * scaleY, 1
        ];

        this.updatePathLine();
        this.updateDirectionBuffer();
        this.updateFOVWedge();
        this.updateMatchLines();
        this.updateScaleBar();
    }

    screenToWorld(screenX, screenY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = (screenX - rect.left) * window.devicePixelRatio;
        const y = (screenY - rect.top) * window.devicePixelRatio;

        const ndcX = (x / this.canvas.width) * 2 - 1;
        const ndcY = (y / this.canvas.height) * 2 - 1;

        const worldX = ndcX * this.canvas.width / (2 * this.zoom) - this.panX;
        const worldY = ndcY * this.canvas.height / (2 * this.zoom) - this.panY;

        return { x: worldX, y: worldY };
    }

    worldToScreen(worldX, worldY) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = (worldX + this.panX) * this.zoom + this.canvas.width / 2;
        const screenY = (worldY + this.panY) * this.zoom + this.canvas.height / 2;
        return {
            x: screenX / window.devicePixelRatio,
            y: screenY / window.devicePixelRatio,
            width: rect.width,
            height: rect.height,
        };
    }

    adjustPanForZoomAnchor() {
        if (!this.zoomAnchorWorld || !this.zoomAnchorScreen) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = (this.zoomAnchorScreen.x - rect.left) * window.devicePixelRatio;
        const y = (this.zoomAnchorScreen.y - rect.top) * window.devicePixelRatio;
        const ndcX = (x / this.canvas.width) * 2 - 1;
        const ndcY = (y / this.canvas.height) * 2 - 1;

        const anchoredPanX = ndcX * this.canvas.width / (2 * this.zoom) - this.zoomAnchorWorld.x;
        const anchoredPanY = ndcY * this.canvas.height / (2 * this.zoom) - this.zoomAnchorWorld.y;
        const clamped = this.clampPanToDataBounds(anchoredPanX, anchoredPanY, this.zoom);
        this.panX = clamped.panX;
        this.panY = clamped.panY;
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width * window.devicePixelRatio;
        this.canvas.height = rect.height * window.devicePixelRatio;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.updateViewMatrix();
    }

    render() {
        const gl = this.gl;

        gl.clearColor(0.953, 0.925, 0.851, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (this.showPointCloud && this.pointCloud.length > 0) {
            this.renderPointCloud();
        }

        if (this.showCameras && this.pathVertexCount > 0) {
            this.renderPath();
        }

        if (this.showCameras && this.visibleCameras.length > 0) {
            this.renderCameras();
        }

        if (this.showCameras && this.directionVertexCount > 0) {
            this.renderDirections();
        }

        if (this.showCameras) {
            this.renderOverlayMarkers();
        }

        // Debug match lines (behind selected overlays, on top of cameras)
        if (this.showDebugMatches && this.selectedCamera !== null) {
            this.renderMatchLines();
        }

        // Selected camera overlays should sit on top of all map elements.
        if (this.showCameras && this.selectedCamera !== null) {
            this.renderSelectedFovOverlay();
            this.renderSelectedCameraOverlay();
            this.renderSelectedDirectionOverlay();
        }

        this.renderMapAnnotations();
        this.renderAnnotationBoxes();
        this.renderCalibrationOverlay();
    }

    renderMapAnnotations() {
        const layer = document.getElementById('mapAnnotationLayer');
        if (!layer) return;

        layer.replaceChildren();

        if (!Array.isArray(this.mapAnnotations) || this.mapAnnotations.length === 0) {
            return;
        }

        if (this.zoom < 0.22) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const occupiedRects = [];
        const sortedAnnotations = [...this.mapAnnotations].sort((a, b) => {
            const aTs = Number.isFinite(Number(a.timestampMs)) ? Number(a.timestampMs) : 0;
            const bTs = Number.isFinite(Number(b.timestampMs)) ? Number(b.timestampMs) : 0;
            return aTs - bTs;
        });

        for (const annotation of sortedAnnotations) {
            if (!Array.isArray(annotation.position) || annotation.position.length < 2) continue;

            const stackIndex = Number.isFinite(Number(annotation.stackIndex))
                ? Number(annotation.stackIndex)
                : 0;
            const screen = this.worldToScreen(annotation.position[0], annotation.position[1]);
            const offsetY = stackIndex * 18;
            const left = screen.x;
            const top = screen.y - 16 - offsetY;

            if (left < -20 || top < -30 || left > screen.width + 20 || top > screen.height + 20) {
                continue;
            }

            const label = typeof annotation.label === 'string' ? annotation.label.trim() : '';
            if (!label) continue;

            const approxWidth = Math.min(144, Math.max(52, label.length * 7 + 18));
            const rect = {
                left: left - approxWidth / 2,
                right: left + approxWidth / 2,
                top: top - 10,
                bottom: top + 12,
            };

            const overlaps = occupiedRects.some(existing => (
                rect.left < existing.right &&
                rect.right > existing.left &&
                rect.top < existing.bottom &&
                rect.bottom > existing.top
            ));
            if (overlaps) continue;
            occupiedRects.push(rect);

            const el = document.createElement('div');
            const category = typeof annotation.category === 'string' ? annotation.category.toLowerCase() : 'tag';
            el.className = `map-annotation map-annotation--${category}`;
            el.textContent = label;
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;

            const when = this.formatDateTimeLocal(annotation.dateTimeLocal);
            const categoryLabel = category ? category[0].toUpperCase() + category.slice(1) : 'Tag';
            el.title = when ? `${categoryLabel}: ${label} (${when})` : `${categoryLabel}: ${label}`;
            fragment.appendChild(el);
        }

        layer.appendChild(fragment);
    }

    renderMapLegend() {
        const legend = document.getElementById('mapLegend');
        if (!legend) return;

        const MAP_ANNOTATION_COLORS = {
            department: '#b86e24',
            aisle: '#2b6aa0',
            feature: '#4e8b5f',
        };

        const entries = new Map(); // key -> { color, label }

        // Collect from mapAnnotations (department/aisle/feature tags)
        if (Array.isArray(this.mapAnnotations)) {
            for (const ann of this.mapAnnotations) {
                const cat = typeof ann.category === 'string' ? ann.category.toLowerCase() : '';
                if (!cat) continue;
                const key = `map:${cat}`;
                if (!entries.has(key)) {
                    const color = MAP_ANNOTATION_COLORS[cat] || '#8a5a2b';
                    const displayName = cat[0].toUpperCase() + cat.slice(1);
                    entries.set(key, { color, label: displayName });
                }
            }
        }

        // Collect from annotation boxes (category/location labels)
        for (const box of this.annotations) {
            const label = typeof box.label === 'string' ? box.label.trim() : '';
            const attribute = typeof box.attribute === 'string' ? box.attribute.trim() : '';
            if (!label || !attribute) continue;

            const key = `box:${attribute}:${label}`;
            if (!entries.has(key)) {
                const theme = this.getLabelTheme(label, attribute);
                if (theme && theme.accentColor) {
                    entries.set(key, { color: theme.accentColor, label });
                }
            }
        }

        // Build DOM
        legend.innerHTML = '';
        if (entries.size === 0) {
            legend.classList.remove('visible');
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const { color, label } of entries.values()) {
            const item = document.createElement('div');
            item.className = 'legend-item';

            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            swatch.style.background = color;

            const text = document.createElement('span');
            text.className = 'legend-label';
            text.textContent = label;

            item.appendChild(swatch);
            item.appendChild(text);
            fragment.appendChild(item);
        }
        legend.appendChild(fragment);
        legend.classList.add('visible');
    }

    renderPointCloud() {
        const gl = this.gl;
        gl.useProgram(this.pointProgram);

        const viewLoc = gl.getUniformLocation(this.pointProgram, 'u_viewMatrix');
        const sizeLoc = gl.getUniformLocation(this.pointProgram, 'u_pointSize');
        const colorLoc = gl.getUniformLocation(this.pointProgram, 'u_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform1f(sizeLoc, this.pointSize * window.devicePixelRatio);
        gl.uniform4f(colorLoc, 0.22, 0.22, 0.22, 0.85);

        const posLoc = gl.getAttribLocation(this.pointProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, this.pointCloud.length);
    }

    renderPath() {
        const gl = this.gl;
        gl.useProgram(this.lineProgram);

        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.40, 0.40, 0.40, 0.72);

        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.pathVertexCount);
    }

    renderFOVWedge() {
        const gl = this.gl;
        gl.useProgram(this.lineProgram);

        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.0, 0.0, 0.0, 0.52);

        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.fovBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.fovVertexCount);
    }

    renderDirections() {
        const gl = this.gl;
        gl.useProgram(this.lineProgram);

        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.8, 0.1, 0.1, 0.95);

        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.directionBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.directionVertexCount);
    }

    renderCameras() {
        const gl = this.gl;
        gl.useProgram(this.cameraProgram);

        const viewLoc = gl.getUniformLocation(this.cameraProgram, 'u_viewMatrix');
        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);

        const sizeLoc = gl.getUniformLocation(this.cameraProgram, 'u_pointSize');
        gl.uniform1f(sizeLoc, 12 * window.devicePixelRatio);

        const posLoc = gl.getAttribLocation(this.cameraProgram, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const colorLoc = gl.getAttribLocation(this.cameraProgram, 'a_color');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraColorBuffer);
        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, this.visibleCameras.length);
    }

    renderOverlayMarkers() {
        const overlayCount = this.overlayVisibleCameras.length;
        if (overlayCount === 0) return;

        const gl = this.gl;
        gl.useProgram(this.cameraProgram);
        const viewLoc = gl.getUniformLocation(this.cameraProgram, 'u_viewMatrix');
        const sizeLoc = gl.getUniformLocation(this.cameraProgram, 'u_pointSize');
        const posLoc = gl.getAttribLocation(this.cameraProgram, 'a_position');
        const colorLoc = gl.getAttribLocation(this.cameraProgram, 'a_color');

        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCameraBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.0025); // Speed of pulse animation.  Higher multiplier = faster pulse.
        const haloSize = (18 + 10 * pulse) * window.devicePixelRatio;
        const coreSize = 10 * window.devicePixelRatio;

        const haloColors = new Float32Array(
            Array.from({ length: overlayCount }, () => [1.0, 0.44, 0.12, 0.35]).flat()
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, haloColors, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(sizeLoc, haloSize);
        gl.drawArrays(gl.POINTS, 0, overlayCount);

        const coreColors = new Float32Array(
            Array.from({ length: overlayCount }, () => [0.98, 0.45, 0.18, 1.0]).flat()
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, coreColors, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(sizeLoc, coreSize);
        gl.drawArrays(gl.POINTS, 0, overlayCount);
    }

    renderSelectedCameraOverlay() {
        if (this.selectedCamera === null || !this.selectedIndicatorPose) return;

        const gl = this.gl;
        gl.useProgram(this.cameraProgram);

        const viewLoc = gl.getUniformLocation(this.cameraProgram, 'u_viewMatrix');
        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);

        const sizeLoc = gl.getUniformLocation(this.cameraProgram, 'u_pointSize');
        gl.uniform1f(sizeLoc, 14.4 * window.devicePixelRatio);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedCameraBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([this.selectedIndicatorPose.x, this.selectedIndicatorPose.y]),
            gl.DYNAMIC_DRAW
        );
        const posLoc = gl.getAttribLocation(this.cameraProgram, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const overlayColor = [0.965, 0.831, 0.278, 1.0];
        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedCameraColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(overlayColor), gl.DYNAMIC_DRAW);
        const colorLoc = gl.getAttribLocation(this.cameraProgram, 'a_color');
        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, 1);
    }

    renderSelectedDirectionOverlay() {
        if (this.selectedCamera === null || !this.selectedIndicatorPose) return;

        const dirLength = this.directionPixelsLength / this.zoom;
        const dirThickness = this.directionPixelsThickness / this.zoom;
        const radius = dirThickness / 2;
        const circleSegments = 12;

        const rad = this.selectedIndicatorPose.direction * Math.PI / 180;
        const ux = Math.sin(rad);
        const uy = -Math.cos(rad);
        const dx = dirLength * ux;
        const dy = dirLength * uy;
        const px = -uy * radius;
        const py = ux * radius;

        const startX = this.selectedIndicatorPose.x;
        const startY = this.selectedIndicatorPose.y;
        const endX = startX + dx;
        const endY = startY + dy;
        const triangles = [];

        if (dirLength <= 2 * radius) {
            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2;
            this.pushCircleTriangles(triangles, midX, midY, radius, circleSegments);
        } else {
            const coreStartX = startX + ux * radius;
            const coreStartY = startY + uy * radius;
            const coreEndX = endX - ux * radius;
            const coreEndY = endY - uy * radius;

            triangles.push(
                coreStartX + px, coreStartY + py,
                coreStartX - px, coreStartY - py,
                coreEndX - px, coreEndY - py,
                coreStartX + px, coreStartY + py,
                coreEndX - px, coreEndY - py,
                coreEndX + px, coreEndY + py
            );
            this.pushCircleTriangles(triangles, startX, startY, radius, circleSegments);
            this.pushCircleTriangles(triangles, endX, endY, radius, circleSegments);
        }

        if (triangles.length === 0) return;

        const gl = this.gl;
        gl.useProgram(this.lineProgram);
        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');
        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.8, 0.1, 0.1, 0.95);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedDirectionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.DYNAMIC_DRAW);
        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, triangles.length / 2);
    }

    renderSelectedFovOverlay() {
        if (this.selectedCamera === null || !this.selectedIndicatorPose) return;

        const gl = this.gl;
        const hfov = (this.metadata && this.metadata.hfov) || 104;
        const halfFov = hfov / 2;
        const wedgeLength = 40 / this.zoom;
        const centerDir = this.selectedIndicatorPose.direction;
        const startAngle = centerDir - halfFov;
        const endAngle = centerDir + halfFov;
        const steps = 32;
        const cx = this.selectedIndicatorPose.x;
        const cy = this.selectedIndicatorPose.y;
        const verts = [];

        for (let i = 0; i < steps; i++) {
            const a0 = (startAngle + (endAngle - startAngle) * i / steps) * Math.PI / 180;
            const a1 = (startAngle + (endAngle - startAngle) * (i + 1) / steps) * Math.PI / 180;
            verts.push(cx, cy);
            verts.push(cx + wedgeLength * Math.sin(a0), cy - wedgeLength * Math.cos(a0));
            verts.push(cx + wedgeLength * Math.sin(a1), cy - wedgeLength * Math.cos(a1));
        }

        gl.useProgram(this.lineProgram);
        const viewLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');
        gl.uniformMatrix3fv(viewLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.0, 0.0, 0.0, 0.52);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedFovBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
    }

    // ========================================================================
    // Hit Testing
    // ========================================================================

    hitTestCamera(worldX, worldY) {
        if (!this.showCameras) return null;

        const hitRadius = 25 / this.zoom;
        const hits = [];
        for (const cam of this.visibleCameras) {
            const dx = cam.position[0] - worldX;
            const dy = cam.position[1] - worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < hitRadius) {
                const priority =
                    Number.isFinite(Number(cam.mapHitPriority))
                        ? Number(cam.mapHitPriority)
                        : (cam.isOverlay ? 2 : 1);
                hits.push({ id: cam.id, dist, priority });
            }
        }

        if (hits.length === 0) return null;

        // Prefer overlays (higher priority) when dots overlap/are close;
        // then pick nearest within that priority bucket.
        hits.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.dist - b.dist;
        });
        return hits[0].id;
    }

    // ========================================================================
    // Camera Selection
    // ========================================================================

    selectCamera(id, animateIndicator = false) {
        this.setSelectedCameraState(id, animateIndicator);

        const cam = this.cameras.find(c => c.id === id);
        if (cam) {
            // Update elapsed time
            const elapsed = this.getElapsedMs(id);
            document.getElementById('elapsedTime').textContent = this.formatElapsed(elapsed);
            const imageDateTime = document.getElementById('imageDateTime');
            const idx = this.cameras.findIndex(c => c.id === id);
            const ts = idx >= 0 ? this.cameraTimestamps[idx] : null;
            const dtText = this.formatDateTimeLocal(cam.dateTimeLocal) || this.formatDateTime(ts);
            imageDateTime.textContent = dtText;
            imageDateTime.classList.toggle('visible', dtText.length > 0);
            this.updateImageDateTimePosition();

            // Update header
            document.getElementById('cameraName').textContent = this.getCameraLabel(cam);

            // Show/hide delete companion button (only in annotation mode)
            const delBtn = document.getElementById('deleteCompanionBtn');
            if (delBtn) delBtn.style.display = (cam.isManualCompanion && this.annotationMode) ? '' : 'none';

            // Load image (with caching -- no flicker)
            this.loadImage(cam.imageName);

            // Preload only after selection settles to avoid flooding slow links.
            this.schedulePreloadAdjacentImages(id);

            // Update compass on image overlay
            if (cam.disableCompassFov) {
                this.hideCompass();
            } else {
                const dir = cam.compassDirection !== undefined ? cam.compassDirection : cam.direction;
                this.renderCompass(dir);
            }

            // Update recognition bar
            this.updateImageRecogBar(cam);

            // Update timeline position
            this.updateTimelinePosition(id);

            // Update URL without reloading
            const url = new URL(window.location);
            url.searchParams.set('cam', id);
            window.history.replaceState({}, '', url);

            // Smoothly pan map to keep selected camera visible
            this.smoothPanToCamera(cam);
        }

        this.render();
    }

    deselectCamera() {
        this.selectedCamera = null;
        this.selectedIndicatorPose = null;
        this.selectedIndicatorTargetPose = null;
        this.isAnimatingSelectedIndicator = false;
        document.getElementById('cameraName').textContent = 'No camera selected';
        document.getElementById('elapsedTime').textContent = '';
        const delBtn = document.getElementById('deleteCompanionBtn');
        if (delBtn) delBtn.style.display = 'none';
        const imageDateTime = document.getElementById('imageDateTime');
        imageDateTime.textContent = '';
        imageDateTime.classList.remove('visible');
        this.updateImageRecogBar(null);
        this.desiredMainImageName = null;
        this.pendingMainImageName = null;
        if (this.preloadTimer) {
            clearTimeout(this.preloadTimer);
            this.preloadTimer = null;
        }

        // Clear image and blur overlays -- keep compass canvas and placeholder
        const container = document.getElementById('imageContainer');
        const imgs = container.querySelectorAll('img');
        imgs.forEach(img => img.remove());
        container.querySelectorAll('#blurOverlay, .blur-overlay-old').forEach(el => el.remove());
        const spinner = container.querySelector('.loading-spinner');
        if (spinner) spinner.remove();

        // Restore placeholder if not present
        if (!container.querySelector('.placeholder')) {
            const ph = document.createElement('span');
            ph.className = 'placeholder';
            ph.textContent = 'Click a camera on the map to view its image';
            container.appendChild(ph);
        }

        // Clear compass
        this.hideCompass();

        // Remove cam param from URL
        const url = new URL(window.location);
        url.searchParams.delete('cam');
        window.history.replaceState({}, '', url);

        this.updateVisibleCameras();
        this.updateFOVWedge();
        this.render();
    }

    navigateCamera(delta) {
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;

        if (this.selectedCamera === null) {
            this.selectCamera(navCameras[0].id, true);
            return;
        }

        // For overlay images, first step returns to the associated camera view.
        const associatedBase = this.getAssociatedBaseCameraId(this.selectedCamera);
        if (associatedBase !== null) {
            this.selectCamera(associatedBase, true);
            return;
        }

        const idx = navCameras.findIndex(c => c.id === this.selectedCamera);
        if (idx < 0) {
            this.selectCamera(navCameras[0].id, true);
            return;
        }
        const newIdx = Math.max(0, Math.min(navCameras.length - 1, idx + delta));
        if (newIdx !== idx) {
            this.selectCamera(navCameras[newIdx].id, true);
        }
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
    }

    startPlayback() {
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;

        // If no camera selected, start from the first one
        if (this.selectedCamera === null) {
            this.selectCamera(navCameras[0].id, true);
        }

        this.isPlaying = true;
        this.playbackTimer = setInterval(() => {
            const navCams = this.getNavigationCameras();
            if (navCams.length === 0) { this.stopPlayback(); return; }
            const idx = navCams.findIndex(c => c.id === this.selectedCamera);
            const nextIdx = idx + 1;
            if (nextIdx >= navCams.length) {
                // Reached the end, stop playback
                this.stopPlayback();
                return;
            }
            this.selectCamera(navCams[nextIdx].id, true);
        }, this.playbackInterval);
    }

    stopPlayback() {
        this.isPlaying = false;
        if (this.playbackTimer) {
            clearInterval(this.playbackTimer);
            this.playbackTimer = null;
        }
    }

    smoothPanToCamera(cam) {
        const scaleX = this.zoom * 2 / this.canvas.width;
        const scaleY = -this.zoom * 2 / this.canvas.height;

        const ndcX = (cam.position[0] + this.panX) * scaleX;
        const ndcY = (cam.position[1] + this.panY) * scaleY;

        // Only auto-pan when selected camera is very close to map edges.
        const margin = 0.95;
        if (Math.abs(ndcX) > margin || Math.abs(ndcY) > margin) {
            this.panTargetX = -cam.position[0];
            this.panTargetY = -cam.position[1];

            if (!this.isAnimatingPan) {
                this.isAnimatingPan = true;
                requestAnimationFrame(() => this.animatePan());
            }
        }
    }

    animatePan() {
        const dx = this.panTargetX - this.panX;
        const dy = this.panTargetY - this.panY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.5 / this.zoom) {
            this.panX = this.panTargetX;
            this.panY = this.panTargetY;
            this.updateViewMatrix();
            this.updateVisibleCameras();
            this.render();
            this.isAnimatingPan = false;
            return;
        }

        const lerpFactor = 0.15;
        this.panX += dx * lerpFactor;
        this.panY += dy * lerpFactor;
        this.updateViewMatrix();
        this.updateVisibleCameras();
        this.render();

        requestAnimationFrame(() => this.animatePan());
    }

    // ========================================================================
    // Image Loading & Viewing (with caching, no flicker)
    // ========================================================================

    loadImage(name) {
        const container = document.getElementById('imageContainer');
        this.desiredMainImageName = name;

        // Check cache first -- instant display
        if (this.imageCache.has(name)) {
            this.displayCachedImage(name, container);
            // Latest request is already satisfied; drop older pending work.
            this.pendingMainImageName = null;
            return;
        }

        if (this.mainImageLoading) {
            if (name !== this.activeMainImageName) {
                // Keep only the newest pending request.
                this.pendingMainImageName = name;
            }
            return;
        }

        // Show subtle loading indicator without removing existing image
        let spinner = container.querySelector('.loading-spinner');
        if (!spinner) {
            spinner = document.createElement('span');
            spinner.className = 'loading-spinner';
            spinner.textContent = 'Loading...';
            container.appendChild(spinner);
        }

        const basePath = this._resolveBasePath((this.metadata && this.metadata.imageBasePath) || 'images/');
        // Full URLs are used as-is; relative paths use basePath prefix
        const isFullUrl = /^https?:\/\//i.test(name);
        const candidates = isFullUrl
            ? [name]
            : [basePath + name, basePath + name.replace(/\.[^.]+$/, '') + '.webp', basePath + name.replace(/\.[^.]+$/, '') + '.jpg'];
        this.startMainImageLoad(name, candidates, container);
    }

    startMainImageLoad(name, candidates, container) {
        this.mainImageLoading = true;
        this.activeMainImageName = name;

        const tryAt = (idx) => {
            if (idx >= candidates.length) {
                this.mainImageLoading = false;
                this.activeMainImageName = null;
                if (this.desiredMainImageName === name) {
                    const sp = container.querySelector('.loading-spinner');
                    if (sp) sp.remove();
                }
                this.flushPendingMainImageLoad(container);
                return;
            }

            const newImg = new Image();
            newImg.onload = () => {
                this.addToImageCache(name, newImg);
                const desired = this.desiredMainImageName;
                const shouldDisplay =
                    this.selectedCamera !== null &&
                    (!desired || desired === name || !this.imageCache.has(desired));
                if (shouldDisplay) {
                    this.displayCachedImage(name, container);
                }
                this.mainImageLoading = false;
                this.activeMainImageName = null;
                this.flushPendingMainImageLoad(container);
            };
            newImg.onerror = () => tryAt(idx + 1);
            newImg.src = candidates[idx];
        };

        tryAt(0);
    }

    flushPendingMainImageLoad(container) {
        const next = this.pendingMainImageName;
        this.pendingMainImageName = null;
        if (!next || next === this.activeMainImageName) return;
        this.loadImage(next);
    }

    schedulePreloadAdjacentImages(cameraId) {
        if (this.preloadTimer) {
            clearTimeout(this.preloadTimer);
        }
        this.preloadTimer = setTimeout(() => {
            this.preloadTimer = null;
            if (this.selectedCamera === cameraId) {
                this.preloadAdjacentImages(cameraId);
            }
        }, 250);
    }

    displayCachedImage(name, container) {
        // Remove placeholder and spinner
        const ph = container.querySelector('.placeholder');
        if (ph) ph.remove();
        const sp = container.querySelector('.loading-spinner');
        if (sp) sp.remove();

        const cached = this.imageCache.get(name);
        if (!cached) return;

        const oldImages = Array.from(container.querySelectorAll('img.viewer-main-image'));

        // Clone the cached image for display
        const img = cached.cloneNode();
        img.className = 'viewer-main-image';
        img.draggable = false;
        img.style.position = 'absolute';
        img.style.left = '0';
        img.style.top = '0';
        img.style.opacity = '0';
        container.appendChild(img);

        // Fit image to container
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
        img.style.width = (img.naturalWidth * scale) + 'px';
        img.style.height = (img.naturalHeight * scale) + 'px';

        this.imageBaseWidth = img.naturalWidth * scale;
        this.imageBaseHeight = img.naturalHeight * scale;
        this.imageZoom = 1;
        this.imageOffsetX = (cw - this.imageBaseWidth) / 2;
        this.imageOffsetY = (ch - this.imageBaseHeight) / 2;
        this.imageZoomTarget = this.imageZoom;
        this.imageOffsetXTarget = this.imageOffsetX;
        this.imageOffsetYTarget = this.imageOffsetY;

        this.updateImageTransform(img);
        this.updateBlurOverlay(name, container);

        requestAnimationFrame(() => {
            img.style.opacity = '1';
            setTimeout(() => {
                oldImages.forEach(old => old.remove());
                // Also remove orphaned old blur overlays
                container.querySelectorAll('.blur-overlay-old').forEach(el => el.remove());
            }, 160);
        });
    }

    updateBlurOverlay(imageName, container) {
        // Mark any existing overlay as old (will be cleaned up after fade)
        const existing = container.querySelector('#blurOverlay');
        if (existing) {
            existing.id = '';
            existing.classList.add('blur-overlay-old');
        }

        // Look up detections by image stem (no extension)
        const stem = imageName.replace(/\.[^.]+$/, '');
        const dets = this.detections[stem];
        if (!dets || dets.length === 0) return;

        // Create overlay div matching the image dimensions
        const overlay = document.createElement('div');
        overlay.id = 'blurOverlay';
        overlay.style.width = this.imageBaseWidth + 'px';
        overlay.style.height = this.imageBaseHeight + 'px';

        for (const det of dets) {
            const [x, y, w, h] = det.bbox;
            const region = document.createElement('div');
            region.className = 'blur-region';
            region.style.left = (x * 100) + '%';
            region.style.top = (y * 100) + '%';
            region.style.width = (w * 100) + '%';
            region.style.height = (h * 100) + '%';
            overlay.appendChild(region);
        }

        // Apply same transform as the image
        overlay.style.transform = `translate(${this.imageOffsetX}px, ${this.imageOffsetY}px) scale(${this.imageZoom})`;
        overlay.style.transformOrigin = '0 0';
        container.appendChild(overlay);
    }

    addToImageCache(name, img) {
        this.imageCache.set(name, img);
        // Evict oldest entries if over max
        if (this.imageCache.size > this.imageCacheMaxSize) {
            const firstKey = this.imageCache.keys().next().value;
            this.imageCache.delete(firstKey);
        }
    }

    preloadAdjacentImages(cameraId) {
        const idx = this.cameras.findIndex(c => c.id === cameraId);
        const basePath = this._resolveBasePath((this.metadata && this.metadata.imageBasePath) || 'images/');

        const toPreload = [];
        if (idx > 0) toPreload.push(this.cameras[idx - 1].imageName);
        if (idx < this.cameras.length - 1) toPreload.push(this.cameras[idx + 1].imageName);

        for (const name of toPreload) {
            if (this.imageCache.has(name)) continue;
            const img = new Image();
            img.onload = () => this.addToImageCache(name, img);
            img.src = /^https?:\/\//i.test(name) ? name : basePath + name;
        }
    }

    updateImageTransform(img) {
        if (!img) return;
        const t = `translate(${this.imageOffsetX}px, ${this.imageOffsetY}px) scale(${this.imageZoom})`;
        img.style.transform = t;
        img.style.transformOrigin = '0 0';

        // Sync blur overlay transform
        const overlay = document.getElementById('blurOverlay');
        if (overlay) {
            overlay.style.transform = t;
            overlay.style.transformOrigin = '0 0';
        }

        this.updateImageDateTimePosition();
        this.updateCompassPosition();
    }

    getMainImageElement(container = document.getElementById('imageContainer')) {
        if (!container) return null;
        const imgs = container.querySelectorAll('img.viewer-main-image');
        return imgs.length > 0 ? imgs[imgs.length - 1] : null;
    }

    updateImageDateTimePosition() {
        const badge = document.getElementById('imageDateTime');
        const container = document.getElementById('imageContainer');
        if (!badge || !container || !badge.classList.contains('visible')) return;

        const scaledW = this.imageBaseWidth * this.imageZoom;
        const scaledH = this.imageBaseHeight * this.imageZoom;
        if (!(scaledW > 0 && scaledH > 0)) return;

        const pad = 10;
        const badgeW = badge.offsetWidth || 120;
        const badgeH = badge.offsetHeight || 22;
        let left = this.imageOffsetX + scaledW - badgeW - pad;
        let top = this.imageOffsetY + scaledH - badgeH - pad;

        // Keep the badge inside the image container when the image is small.
        left = Math.max(pad, Math.min(container.clientWidth - badgeW - pad, left));
        top = Math.max(pad, Math.min(container.clientHeight - badgeH - pad, top));

        badge.style.left = `${left}px`;
        badge.style.top = `${top}px`;
    }

    updateCompassPosition() {
        const compass = this.compassCanvas;
        const container = document.getElementById('imageContainer');
        if (!compass || !container) return;

        const scaledW = this.imageBaseWidth * this.imageZoom;
        const scaledH = this.imageBaseHeight * this.imageZoom;
        if (!(scaledW > 0 && scaledH > 0)) return;

        const pad = 10;
        const compassSize = 100;
        let left = this.imageOffsetX + pad;
        let top = this.imageOffsetY + pad;

        // Keep compass anchored to the image while staying inside container bounds.
        left = Math.max(pad, Math.min(container.clientWidth - compassSize - pad, left));
        top = Math.max(pad, Math.min(container.clientHeight - compassSize - pad, top));

        compass.style.left = `${left}px`;
        compass.style.top = `${top}px`;
    }

    clampImageOffset(container) {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const scaledW = this.imageBaseWidth * this.imageZoom;
        const scaledH = this.imageBaseHeight * this.imageZoom;

        if (scaledW <= cw) {
            this.imageOffsetX = (cw - scaledW) / 2;
        } else {
            this.imageOffsetX = Math.max(cw - scaledW, Math.min(0, this.imageOffsetX));
        }

        if (scaledH <= ch) {
            this.imageOffsetY = (ch - scaledH) / 2;
        } else {
            this.imageOffsetY = Math.max(ch - scaledH, Math.min(0, this.imageOffsetY));
        }
    }

    refitImage() {
        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img || !img.naturalWidth) return;

        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
        img.style.width = (img.naturalWidth * scale) + 'px';
        img.style.height = (img.naturalHeight * scale) + 'px';

        this.imageBaseWidth = img.naturalWidth * scale;
        this.imageBaseHeight = img.naturalHeight * scale;
        this.imageZoom = 1;
        this.imageOffsetX = (cw - this.imageBaseWidth) / 2;
        this.imageOffsetY = (ch - this.imageBaseHeight) / 2;
        this.imageZoomTarget = this.imageZoom;
        this.imageOffsetXTarget = this.imageOffsetX;
        this.imageOffsetYTarget = this.imageOffsetY;

        this.updateImageTransform(img);
    }

    setImageViewTarget(targetZoom, targetOffsetX, targetOffsetY) {
        const container = document.getElementById('imageContainer');
        const prevZoom = this.imageZoom;
        const prevOffsetX = this.imageOffsetX;
        const prevOffsetY = this.imageOffsetY;

        this.imageZoom = targetZoom;
        this.imageOffsetX = targetOffsetX;
        this.imageOffsetY = targetOffsetY;
        this.clampImageOffset(container);
        this.imageZoomTarget = this.imageZoom;
        this.imageOffsetXTarget = this.imageOffsetX;
        this.imageOffsetYTarget = this.imageOffsetY;

        this.imageZoom = prevZoom;
        this.imageOffsetX = prevOffsetX;
        this.imageOffsetY = prevOffsetY;

        if (!this.isAnimatingImageView) {
            this.isAnimatingImageView = true;
            this.lastImageViewTime = performance.now();
            requestAnimationFrame(() => this.animateImageView());
        }
    }

    setImageZoomTargetAroundPoint(targetZoom, anchorX, anchorY) {
        const imgX = (anchorX - this.imageOffsetX) / this.imageZoom;
        const imgY = (anchorY - this.imageOffsetY) / this.imageZoom;
        const targetOffsetX = anchorX - imgX * targetZoom;
        const targetOffsetY = anchorY - imgY * targetZoom;
        this.setImageViewTarget(targetZoom, targetOffsetX, targetOffsetY);
    }

    animateImageView() {
        if (!this.isAnimatingImageView) return;

        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img || !this.imageBaseWidth) {
            this.isAnimatingImageView = false;
            return;
        }

        const now = performance.now();
        const dt = Math.min((now - this.lastImageViewTime) / 1000, 0.05);
        this.lastImageViewTime = now;

        const dz = this.imageZoomTarget - this.imageZoom;
        const dx = this.imageOffsetXTarget - this.imageOffsetX;
        const dy = this.imageOffsetYTarget - this.imageOffsetY;
        const done = Math.abs(dz) < 0.002 && Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2;

        if (done) {
            this.imageZoom = this.imageZoomTarget;
            this.imageOffsetX = this.imageOffsetXTarget;
            this.imageOffsetY = this.imageOffsetYTarget;
            this.updateImageTransform(img);
            this.isAnimatingImageView = false;
            return;
        }

        const lerpFactor = 1 - Math.exp(-14 * dt);
        this.imageZoom += dz * lerpFactor;
        this.imageOffsetX += dx * lerpFactor;
        this.imageOffsetY += dy * lerpFactor;
        this.updateImageTransform(img);

        requestAnimationFrame(() => this.animateImageView());
    }

    // ========================================================================
    // Compass Rose (drawn on image panel overlay)
    // ========================================================================

    renderCompass(direction) {
        if (direction === null || direction === undefined) return;
        this.compassCanvas.style.display = 'block';
        const normalized = ((direction % 360) + 360) % 360;
        if (this.compassDirection === null) {
            this.compassDirection = normalized;
        }
        this.compassTargetDirection = normalized;
        if (!this.isAnimatingCompass) {
            this.isAnimatingCompass = true;
            this.lastCompassTime = performance.now();
            requestAnimationFrame(() => this.animateCompass());
        }
    }

    hideCompass() {
        const ctx = this.compassCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.compassCanvas.width, this.compassCanvas.height);
        this.isAnimatingCompass = false;
        this.compassDirection = null;
        this.compassTargetDirection = null;
        this.compassCanvas.style.display = 'none';
    }

    animateCompass() {
        if (!this.isAnimatingCompass || this.compassDirection === null || this.compassTargetDirection === null) {
            return;
        }

        const now = performance.now();
        const dt = Math.min((now - this.lastCompassTime) / 1000, 0.05);
        this.lastCompassTime = now;

        // Move along shortest angular path.
        const delta = ((this.compassTargetDirection - this.compassDirection + 540) % 360) - 180;
        if (Math.abs(delta) < 0.2) {
            this.compassDirection = this.compassTargetDirection;
            this.drawCompassAtDirection(this.compassDirection);
            this.isAnimatingCompass = false;
            return;
        }

        // Fast but smooth convergence.
        const lerpFactor = 1 - Math.exp(-20 * dt);
        this.compassDirection = (this.compassDirection + delta * lerpFactor + 360) % 360;
        this.drawCompassAtDirection(this.compassDirection);
        requestAnimationFrame(() => this.animateCompass());
    }

    drawCompassAtDirection(direction) {
        const canvas = this.compassCanvas;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2 - 8;

        ctx.clearRect(0, 0, w, h);

        // Background circle
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(48, 48, 48, 0.88)';
        ctx.fill();

        // FOV pie slice (points up = camera direction)
        const hfov = (this.metadata && this.metadata.hfov) || 104;
        const halfFov = hfov / 2 * Math.PI / 180;
        const dirRad = -Math.PI / 2; // up in canvas coords
        const startAngle = dirRad - halfFov;
        const endAngle = dirRad + halfFov;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = 'rgba(190, 190, 190, 0.20)';
        ctx.fill();

        // N/E/S/W markers rotated so camera direction faces up
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const markers = [
            { label: 'N', angle: 0 },
            { label: 'E', angle: 90 },
            { label: 'S', angle: 180 },
            { label: 'W', angle: 270 },
        ];

        const markerR = r * 0.7;
        for (const m of markers) {
            const a = (m.angle - direction) * Math.PI / 180 - Math.PI / 2;
            const mx = cx + markerR * Math.cos(a);
            const my = cy + markerR * Math.sin(a);

            if (m.label === 'N') {
                ctx.font = 'bold 18px sans-serif';
                ctx.fillStyle = '#c62828';
            } else {
                ctx.font = 'bold 14px sans-serif';
                ctx.fillStyle = '#ffffff';
            }
            ctx.fillText(m.label, mx, my);
        }
    }

    // ========================================================================
    // Timeline Scrubber
    // ========================================================================

    updateTimelinePosition(cameraId) {
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;

        const idx = navCameras.findIndex(c => c.id === cameraId);
        if (idx < 0) return;

        const pct = navCameras.length > 1 ? idx / (navCameras.length - 1) * 100 : 0;

        document.getElementById('timelineProgress').style.width = pct + '%';
        this.positionTimelineThumbByPercent(pct);
    }

    positionTimelineThumbByPercent(pct) {
        const thumb = document.getElementById('timelineThumb');
        const track = document.getElementById('timelineTrack');
        const timeline = document.getElementById('timeline');
        if (!thumb || !track || !timeline) return;

        const trackRect = track.getBoundingClientRect();
        const timelineRect = timeline.getBoundingClientRect();
        const clampedPct = Math.max(0, Math.min(100, pct));
        let leftPx = trackRect.left - timelineRect.left + (clampedPct / 100) * trackRect.width;

        // Keep thumb fully inside track bounds instead of letting it overhang.
        const thumbRadius = thumb.offsetWidth / 2;
        const minLeft = trackRect.left - timelineRect.left + thumbRadius;
        const maxLeft = trackRect.right - timelineRect.left - thumbRadius;
        leftPx = Math.max(minLeft, Math.min(maxLeft, leftPx));

        thumb.style.left = leftPx + 'px';
    }

    getTimelineCameraIndex(clientX) {
        const navCameras = this.getNavigationCameras();
        const track = document.getElementById('timelineTrack');
        const rect = track.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return Math.round(pct * (navCameras.length - 1));
    }

    showTimelineThumbnail(clientX, cameraIdx) {
        const navCameras = this.getNavigationCameras();
        const cam = navCameras[cameraIdx];
        if (!cam) return;

        // Position popup immediately (even before image loads)
        const popup = document.getElementById('timelineThumbnail');
        const track = document.getElementById('timelineTrack');
        const trackRect = track.getBoundingClientRect();
        const timelineRect = document.getElementById('timeline').getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - trackRect.left) / trackRect.width));
        let leftPx = trackRect.left - timelineRect.left + pct * trackRect.width;

        // Keep popup fully inside the timeline panel.
        const popupWidth = popup.offsetWidth || 158; // approximate width before first render
        const halfPopup = popupWidth / 2;
        const minLeft = halfPopup;
        const maxLeft = timelineRect.width - halfPopup;
        leftPx = Math.max(minLeft, Math.min(maxLeft, leftPx));

        popup.style.left = leftPx + 'px';

        const popupLabel = popup.querySelector('.thumb-label');
        popupLabel.textContent = this.getThumbnailCaption(cam);
        const tlThumbRecog = popup.querySelector('.thumb-recog');
        if (tlThumbRecog) {
            const summary = this.getRecogSummary(cam);
            this._renderRecogTags(tlThumbRecog, summary);
            tlThumbRecog.classList.toggle('visible', Boolean(summary));
        }
        popup.classList.add('visible');

        this.pendingTimelineThumbnail = { imageName: cam.imageName };
        this.processTimelineThumbnailQueue();
    }

    hideTimelineThumbnail() {
        this.pendingTimelineThumbnail = null;
        document.getElementById('timelineThumbnail').classList.remove('visible');
    }

    processTimelineThumbnailQueue() {
        if (this.timelineThumbnailLoading || !this.pendingTimelineThumbnail) return;

        const next = this.pendingTimelineThumbnail;
        this.pendingTimelineThumbnail = null;

        const popup = document.getElementById('timelineThumbnail');
        const popupImg = popup.querySelector('img');
        const thumbBase = this._resolveBasePath((this.metadata && this.metadata.thumbnailBasePath) || 'thumbnails/');

        this.timelineThumbnailLoading = true;
        popupImg.onload = () => {
            this.timelineThumbnailLoading = false;
            this.processTimelineThumbnailQueue();
        };
        popupImg.onerror = () => {
            this.timelineThumbnailLoading = false;
            this.processTimelineThumbnailQueue();
        };
        popupImg.src = /^https?:\/\//i.test(next.imageName) ? next.imageName : thumbBase + next.imageName;
    }

    // ========================================================================
    // Map Hover Thumbnail
    // ========================================================================

    showMapThumbnail(camId, screenX, screenY) {
        const cam = this.cameras.find(c => c.id === camId);
        if (!cam) return;

        // Position popup - offset to avoid overlapping the FOV wedge
        // Place it to the right and above the cursor
        const popup = document.getElementById('mapThumbnail');
        const mapRect = this.canvas.parentElement.getBoundingClientRect();
        let left = screenX - mapRect.left + 20;
        let top = screenY - mapRect.top - 130;

        // Keep popup within map bounds
        if (left + 170 > mapRect.width) left = screenX - mapRect.left - 180;
        if (top < 5) top = screenY - mapRect.top + 20;

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
        popup.querySelector('.thumb-label').textContent = this.getThumbnailCaption(cam);
        const mapThumbRecog = popup.querySelector('.thumb-recog');
        if (mapThumbRecog) {
            const summary = this.getRecogSummary(cam);
            this._renderRecogTags(mapThumbRecog, summary);
            mapThumbRecog.classList.toggle('visible', Boolean(summary));
        }
        popup.classList.add('visible');

        this.pendingMapThumbnail = { imageName: cam.imageName };
        this.processMapThumbnailQueue();
    }

    hideMapThumbnail() {
        this.pendingMapThumbnail = null;
        const popup = document.getElementById('mapThumbnail');
        popup.classList.remove('visible');
    }

    clearMapHoverState() {
        this.hoveredCamera = null;
        this.hideMapThumbnail();
        this.canvas.style.cursor = 'grab';
    }

    processMapThumbnailQueue() {
        if (this.mapThumbnailLoading || !this.pendingMapThumbnail) return;

        const next = this.pendingMapThumbnail;
        this.pendingMapThumbnail = null;

        const popup = document.getElementById('mapThumbnail');
        const popupImg = popup.querySelector('img');
        const thumbBase = this._resolveBasePath((this.metadata && this.metadata.thumbnailBasePath) || 'thumbnails/');

        this.mapThumbnailLoading = true;
        popupImg.onload = () => {
            this.mapThumbnailLoading = false;
            this.processMapThumbnailQueue();
        };
        popupImg.onerror = () => {
            this.mapThumbnailLoading = false;
            this.processMapThumbnailQueue();
        };
        popupImg.src = /^https?:\/\//i.test(next.imageName) ? next.imageName : thumbBase + next.imageName;
    }

    // ========================================================================
    // Calibration / Scale Bar
    // ========================================================================

    toggleCalibrationMode() {
        this.calibrationMode = !this.calibrationMode;
        const btn = document.getElementById('calibrateBtn');
        btn.classList.toggle('active', this.calibrationMode);

        if (this.calibrationMode) {
            // Exit annotation mode if active
            if (this.annotationMode) {
                this.toggleAnnotationMode();
            }
            this.calibrationPoints = [];
            this.canvas.style.cursor = 'crosshair';
        } else {
            this.calibrationPoints = [];
            this.canvas.style.cursor = 'grab';
            this.render();
        }
    }

    onCalibrationClick(e) {
        if (!this.calibrationMode || e.button !== 0) return false;

        const world = this.screenToWorld(e.clientX, e.clientY);
        this.calibrationPoints.push(world);
        this.render();

        if (this.calibrationPoints.length >= 2) {
            this.showCalibrateDialog();
        }
        return true;
    }

    showCalibrateDialog() {
        const dialog = document.getElementById('calibrateDialog');
        const input = document.getElementById('calibrateDistInput');
        dialog.classList.add('visible');
        input.value = '';
        input.focus();
    }

    confirmCalibration() {
        const input = document.getElementById('calibrateDistInput');
        const select = document.getElementById('calibrateUnitSelect');
        const realDist = parseFloat(input.value);

        if (!realDist || realDist <= 0) {
            input.focus();
            return;
        }

        const a = this.calibrationPoints[0];
        const b = this.calibrationPoints[1];
        const worldDist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

        if (worldDist < 1e-9) {
            alert('The two points are too close. Please try again.');
            this.cancelCalibration();
            return;
        }

        this.baseRatio = realDist / worldDist;
        this.calibrationUnit = select.value;

        // Persist
        try {
            localStorage.setItem('scaleCalibration', JSON.stringify({
                baseRatio: this.baseRatio,
                unit: this.calibrationUnit,
            }));
        } catch (_) { /* ignore */ }

        document.getElementById('calibrateDialog').classList.remove('visible');

        // Exit calibration mode
        this.calibrationMode = false;
        document.getElementById('calibrateBtn').classList.remove('active');
        this.calibrationPoints = [];
        this.canvas.style.cursor = 'grab';

        // Show scale bar
        document.getElementById('scaleBar').style.display = '';
        this.updateScaleBar();
        this.render();
        this.hasUnsavedChanges = true;
    }

    cancelCalibration() {
        document.getElementById('calibrateDialog').classList.remove('visible');
        this.calibrationPoints = [];
        this.calibrationMode = false;
        document.getElementById('calibrateBtn').classList.remove('active');
        this.canvas.style.cursor = 'grab';
        this.render();
    }

    updateScaleBar() {
        if (this.baseRatio === null) return;

        const scaleBar = document.getElementById('scaleBar');
        if (!scaleBar) return;

        // 100 CSS pixels → how many world units?
        // worldToScreen: screenX = (worldX + panX) * zoom + canvas.width/2
        // So 1 world unit = zoom physical pixels = zoom / devicePixelRatio CSS pixels
        // Therefore 100 CSS px = 100 * devicePixelRatio / zoom world units
        const dpr = window.devicePixelRatio || 1;
        const worldDistFor100px = 100 * dpr / this.zoom;
        let realDist = worldDistFor100px * this.baseRatio;

        let unit = this.calibrationUnit;

        // Auto-convert for readability
        if (unit === 'm') {
            if (realDist >= 1000) {
                realDist /= 1000;
                unit = 'km';
            } else if (realDist < 0.01) {
                realDist *= 1000;
                unit = 'mm';
            } else if (realDist < 1) {
                realDist *= 100;
                unit = 'cm';
            }
        } else if (unit === 'mm') {
            if (realDist >= 1000000) {
                realDist /= 1000000;
                unit = 'km';
            } else if (realDist >= 1000) {
                realDist /= 1000;
                unit = 'm';
            } else if (realDist >= 10) {
                realDist /= 10;
                unit = 'cm';
            }
        } else if (unit === 'cm') {
            if (realDist >= 100000) {
                realDist /= 100000;
                unit = 'km';
            } else if (realDist >= 100) {
                realDist /= 100;
                unit = 'm';
            } else if (realDist < 0.1) {
                realDist *= 10;
                unit = 'mm';
            }
        } else if (unit === 'km') {
            if (realDist < 0.001) {
                realDist *= 1000000;
                unit = 'mm';
            } else if (realDist < 0.01) {
                realDist *= 100000;
                unit = 'cm';
            } else if (realDist < 1) {
                realDist *= 1000;
                unit = 'm';
            }
        }
        // ft: no auto-conversion

        // Format number
        let text;
        if (realDist >= 100) {
            text = Math.round(realDist).toString();
        } else if (realDist >= 10) {
            text = realDist.toFixed(1).replace(/\.0$/, '');
        } else if (realDist >= 1) {
            text = realDist.toFixed(2).replace(/\.?0+$/, '');
        } else {
            text = realDist.toPrecision(2);
        }

        scaleBar.querySelector('.scale-bar-text').textContent = text + ' ' + unit;
    }

    renderCalibrationOverlay() {
        if (!this.calibrationMode || this.calibrationPoints.length === 0) return;

        const gl = this.gl;
        const pts = this.calibrationPoints;

        // Draw calibration points as small circles and the connecting line
        const verts = [];

        // Draw dots at each calibration point (small cross pattern)
        const dotSize = 5 / this.zoom; // 5px in screen space
        for (const pt of pts) {
            // Horizontal bar
            verts.push(pt.x - dotSize, pt.y, pt.x + dotSize, pt.y);
            // Vertical bar
            verts.push(pt.x, pt.y - dotSize, pt.x, pt.y + dotSize);
        }

        // Draw connecting line if we have 2 points
        if (pts.length >= 2) {
            verts.push(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        }

        if (verts.length === 0) return;

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

        gl.useProgram(this.lineProgram);
        const posLoc = gl.getAttribLocation(this.lineProgram, 'a_position');
        const matLoc = gl.getUniformLocation(this.lineProgram, 'u_viewMatrix');
        const colorLoc = gl.getUniformLocation(this.lineProgram, 'u_color');

        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix3fv(matLoc, false, this.viewMatrix);
        gl.uniform4f(colorLoc, 0.90, 0.25, 0.20, 1.0); // red-ish color

        gl.lineWidth(2.0);
        gl.drawArrays(gl.LINES, 0, verts.length / 2);

        gl.deleteBuffer(buffer);
    }

    restoreCalibration(data) {
        // Prefer calibration from data file, fall back to localStorage
        let baseRatio = null;
        let unit = 'm';

        if (data && data.scaleCalibration && data.scaleCalibration.baseRatio > 0) {
            baseRatio = data.scaleCalibration.baseRatio;
            unit = data.scaleCalibration.unit || 'm';
        } else {
            try {
                const saved = localStorage.getItem('scaleCalibration');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed.baseRatio > 0) {
                        baseRatio = parsed.baseRatio;
                        unit = parsed.unit || 'm';
                    }
                }
            } catch (_) { /* ignore */ }
        }

        if (baseRatio !== null) {
            this.baseRatio = baseRatio;
            this.calibrationUnit = unit;
            document.getElementById('scaleBar').style.display = '';
            this.updateScaleBar();
        } else {
            this.baseRatio = null;
            document.getElementById('scaleBar').style.display = 'none';
        }
    }

    // ========================================================================
    // Annotation Mode
    // ========================================================================

    toggleAnnotationMode() {
        this.annotationMode = !this.annotationMode;
        const btn = document.getElementById('annotationModeBtn');
        const controls = document.getElementById('annotationControls');

        // Exit calibration mode if entering annotation mode
        if (this.annotationMode && this.calibrationMode) {
            this.calibrationMode = false;
            this.calibrationPoints = [];
            document.getElementById('calibrateBtn').classList.remove('active');
        }

        btn.classList.toggle('active', this.annotationMode);
        controls.style.display = this.annotationMode ? 'flex' : 'none';
        document.getElementById('companionModeBtn').style.display = this.annotationMode ? '' : 'none';

        // Exit companion mode when leaving annotation mode
        if (!this.annotationMode && this.companionMode) {
            this.companionMode = false;
            document.getElementById('companionModeBtn').classList.remove('active');
            const dialog = document.getElementById('companionDialog');
            if (dialog) dialog.remove();
        }

        // Cancel any in-progress drawing
        this.isDrawingBox = false;
        this.drawStartWorld = null;
        this.isBoxDrawMode = false;
        this.canvas.style.cursor = 'grab';
        this.drawCurrentWorld = null;
        if (!this.annotationMode) {
            this.selectedAnnotation = null;
        }
        this.renderAnnotationBoxes();
    }

    // ========================================================================
    // Companion Mode
    // ========================================================================

    toggleCompanionMode() {
        this.companionMode = !this.companionMode;
        const btn = document.getElementById('companionModeBtn');
        btn.classList.toggle('active', this.companionMode);

        // Exit conflicting modes but stay in annotation mode
        if (this.companionMode) {
            if (this.calibrationMode) {
                this.calibrationMode = false;
                this.calibrationPoints = [];
                document.getElementById('calibrateBtn').classList.remove('active');
            }
            // Exit box draw mode
            this.isDrawingBox = false;
            this.isBoxDrawMode = false;
            this.drawStartWorld = null;
            this.drawCurrentWorld = null;
        }

        this.canvas.style.cursor = this.companionMode ? 'crosshair' : 'grab';
    }

    showCompanionDialog(worldX, worldY, screenX, screenY) {
        // Remove any existing dialog
        const existing = document.getElementById('companionDialog');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.id = 'companionDialog';
        dialog.className = 'companion-dialog';

        const mapPanel = document.getElementById('mapPanel');
        const rect = mapPanel.getBoundingClientRect();
        dialog.style.left = `${Math.max(4, Math.min(rect.width - 320, screenX - rect.left + 4))}px`;
        dialog.style.top = `${Math.max(4, Math.min(rect.height - 160, screenY - rect.top + 4))}px`;

        dialog.innerHTML = `
            <div class="companion-dialog-title">Add Companion Photo</div>
            <label class="companion-dialog-label">Image URL:</label>
            <input type="text" id="companionUrlInput" class="companion-dialog-input" placeholder="https://... or relative path" autofocus>
            <div class="companion-dialog-btns">
                <button id="companionOkBtn" class="companion-dialog-ok">OK</button>
                <button id="companionCancelBtn" class="companion-dialog-cancel">Cancel</button>
            </div>
        `;

        mapPanel.appendChild(dialog);

        const urlInput = document.getElementById('companionUrlInput');

        const cleanup = () => {
            dialog.remove();
            if (this._companionDialogKeyHandler) {
                document.removeEventListener('keydown', this._companionDialogKeyHandler);
                this._companionDialogKeyHandler = null;
            }
        };

        const commit = () => {
            const url = urlInput.value.trim();
            if (!url) { urlInput.focus(); return; }
            this.addCompanionCamera(worldX, worldY, url);
            cleanup();
        };

        document.getElementById('companionOkBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            commit();
        });

        document.getElementById('companionCancelBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            cleanup();
        });

        this._companionDialogKeyHandler = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
            }
        };
        document.addEventListener('keydown', this._companionDialogKeyHandler);

        setTimeout(() => urlInput.focus(), 50);
    }

    addCompanionCamera(worldX, worldY, imageUrl) {
        // Find nearest base camera for association
        const baseCameras = this.cameras.filter(c => !c.isOverlay);
        let nearestId = null;
        let nearestDist = Infinity;
        let nearestDir = 0;
        let previousId = null;
        let nextId = null;

        for (const cam of baseCameras) {
            const dx = cam.position[0] - worldX;
            const dy = cam.position[1] - worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestId = cam.id;
                nearestDir = cam.direction || 0;
            }
        }

        // Find previous and next camera relative to the nearest
        if (nearestId !== null) {
            const idx = baseCameras.findIndex(c => c.id === nearestId);
            previousId = idx > 0 ? baseCameras[idx - 1].id : baseCameras[idx].id;
            nextId = idx < baseCameras.length - 1 ? baseCameras[idx + 1].id : baseCameras[idx].id;
        }

        const id = this.nextManualCompanionId++;
        const now = new Date();
        const dateTimeLocal = now.toISOString().replace('T', ' ').replace('Z', '');

        const companion = {
            id: id,
            imageName: imageUrl,
            position: [worldX, worldY],
            direction: nearestDir,
            compassDirection: nearestDir,
            keep: true,
            isOverlay: true,
            overlayKind: 'companionPhoto',
            associatedCameraId: nearestId,
            previousCameraId: previousId,
            nextCameraId: nextId,
            interpolationRatio: 0,
            timestampMs: Date.now(),
            dateTimeLocal: dateTimeLocal,
            mapHitPriority: 3,
            title: 'Companion Photo - manual',
            disableCompassFov: false,
            isManualCompanion: true,
        };

        this.cameras.push(companion);
        this.manualCompanions.push(companion);
        this.cameraTimestamps.push(companion.timestampMs);

        this.hasOverlayCameras = true;
        this.updateOverlayPulseAnimationState();
        this.updateVisibleCameras();
        this.hasUnsavedChanges = true;
        this.render();

        // Select the newly added companion
        this.selectCamera(id);
    }

    removeCompanionCamera(id) {
        const idx = this.cameras.findIndex(c => c.id === id);
        if (idx < 0) return;
        const cam = this.cameras[idx];
        if (!cam.isManualCompanion) return;

        this.cameras.splice(idx, 1);
        this.cameraTimestamps.splice(idx, 1);
        this.manualCompanions = this.manualCompanions.filter(c => c.id !== id);

        if (this.selectedCamera === id) this.deselectCamera();
        this.hasOverlayCameras = this.cameras.some(c => c.isOverlay);
        this.updateOverlayPulseAnimationState();
        this.updateVisibleCameras();
        this.hasUnsavedChanges = true;
        this.render();
    }

    computeDataCenter() {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const cam of this.cameras) {
            minX = Math.min(minX, cam.position[0]);
            minY = Math.min(minY, cam.position[1]);
            maxX = Math.max(maxX, cam.position[0]);
            maxY = Math.max(maxY, cam.position[1]);
        }

        for (const pt of this.pointCloud) {
            minX = Math.min(minX, pt[0]);
            minY = Math.min(minY, pt[1]);
            maxX = Math.max(maxX, pt[0]);
            maxY = Math.max(maxY, pt[1]);
        }

        if (!isFinite(minX)) return { x: 0, y: 0 };
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }

    async loadLabelsConfig() {
        const STORAGE_KEY = 'storeBEV_customLabels';
        try {
            const resp = await fetch(this.labelsYamlUrl);
            if (!resp.ok) return;
            const text = await resp.text();
            const lines = text.split('\n');
            let inLabels = false;
            let currentGroup = null;
            const groups = {};
            const groupOrder = [];
            const flatLabels = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith('#')) continue;
                if (/^labels\s*:/.test(trimmed)) { inLabels = true; continue; }
                if (!inLabels) continue;
                // Non-indented line after labels: -> end of labels block
                if (!line.startsWith(' ') && !line.startsWith('\t')) { inLabels = false; continue; }

                // Check for group header (e.g. "  location:")
                const groupMatch = line.match(/^(\s{2,4}|\t)(\w[\w\s]*\w|\w+)\s*:\s*$/);
                if (groupMatch) {
                    currentGroup = groupMatch[2].trim();
                    if (!groups[currentGroup]) {
                        groups[currentGroup] = [];
                        groupOrder.push(currentGroup);
                    }
                    continue;
                }
                // List item under a group or flat
                const itemMatch = line.match(/^\s*-\s+(.+)$/);
                if (itemMatch) {
                    const label = itemMatch[1].trim();
                    if (currentGroup) {
                        groups[currentGroup].push(label);
                    }
                    flatLabels.push(label);
                }
            }

            this.configuredLabelGroups = groups;
            this.configuredLabelGroupNames = groupOrder;

            // Merge with localStorage custom labels
            let customLabels = [];
            try {
                customLabels = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            } catch (e) { customLabels = []; }
            const yamlSet = new Set(flatLabels);
            const extra = customLabels.filter(l => !yamlSet.has(l));
            this.configuredLabels = [...flatLabels, ...extra];

            // Add custom labels to a "custom" group if any
            if (extra.length > 0) {
                if (!this.configuredLabelGroups['custom']) {
                    this.configuredLabelGroups['custom'] = [];
                    this.configuredLabelGroupNames.push('custom');
                }
                this.configuredLabelGroups['custom'].push(...extra);
            }
        } catch (e) { /* labels.yaml not available */ }
    }

    saveCustomLabel(label) {
        const STORAGE_KEY = 'storeBEV_customLabels';
        try {
            const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            if (!existing.includes(label)) {
                existing.push(label);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
            }
        } catch (e) { /* ignore */ }
        if (!this.configuredLabels.includes(label)) {
            this.configuredLabels.push(label);
        }
        // Also add to the 'custom' group
        if (!this.configuredLabelGroups['custom']) {
            this.configuredLabelGroups['custom'] = [];
            this.configuredLabelGroupNames.push('custom');
        }
        if (!this.configuredLabelGroups['custom'].includes(label)) {
            this.configuredLabelGroups['custom'].push(label);
        }
    }

    normalizeLabelKey(label) {
        return typeof label === 'string' ? label.trim().toLowerCase() : '';
    }

    getCategoryLabels() {
        return Array.isArray(this.configuredLabelGroups.category)
            ? this.configuredLabelGroups.category
            : [];
    }

    getCategoryColor(label) {
        const normalized = this.normalizeLabelKey(label);
        if (!normalized || this.categoryColorPalette.length === 0) return null;

        const configuredCategories = this.getCategoryLabels();
        const configuredIndex = configuredCategories.findIndex(
            item => this.normalizeLabelKey(item) === normalized
        );
        if (configuredIndex >= 0) {
            return this.categoryColorPalette[configuredIndex % this.categoryColorPalette.length];
        }

        if (!this.categoryColorAssignments.has(normalized)) {
            const nextIndex = (
                configuredCategories.length + this.categoryColorAssignments.size
            ) % this.categoryColorPalette.length;
            this.categoryColorAssignments.set(normalized, this.categoryColorPalette[nextIndex]);
        }
        return this.categoryColorAssignments.get(normalized);
    }

    hexToRgba(hex, alpha) {
        if (typeof hex !== 'string') return `rgba(39, 174, 96, ${alpha})`;
        const normalized = hex.trim();
        const match = normalized.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
        if (!match) return `rgba(39, 174, 96, ${alpha})`;
        const [, r, g, b] = match;
        return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
    }

    getReadableTextColor(hex) {
        if (typeof hex !== 'string') return '#ffffff';
        const normalized = hex.trim();
        const match = normalized.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
        if (!match) return '#ffffff';
        const [, r, g, b] = match;
        const red = parseInt(r, 16);
        const green = parseInt(g, 16);
        const blue = parseInt(b, 16);
        const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
        return luminance > 0.68 ? '#1f1f1f' : '#ffffff';
    }

    parseHexColor(hex) {
        if (typeof hex !== 'string') return null;
        const normalized = hex.trim();
        const match = normalized.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
        if (!match) return null;
        const [, r, g, b] = match;
        return {
            r: parseInt(r, 16),
            g: parseInt(g, 16),
            b: parseInt(b, 16),
        };
    }

    rgbToHex(r, g, b) {
        const toHex = (value) => Math.max(0, Math.min(255, Math.round(value)))
            .toString(16)
            .padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    mixHexColors(hex, targetHex, amount) {
        const source = this.parseHexColor(hex);
        const target = this.parseHexColor(targetHex);
        if (!source || !target) return hex;

        const t = Math.max(0, Math.min(1, amount));
        return this.rgbToHex(
            source.r + (target.r - source.r) * t,
            source.g + (target.g - source.g) * t,
            source.b + (target.b - source.b) * t,
        );
    }

    getAnnotationTextColor(hex) {
        const rgb = this.parseHexColor(hex);
        if (!rgb) return '#352b1f';

        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;

        if (luminance >= 0.72) {
            return this.mixHexColors(hex, '#1f1a14', 0.72);
        }
        if (luminance >= 0.55) {
            return this.mixHexColors(hex, '#1f1a14', 0.52);
        }
        if (luminance <= 0.18) {
            return this.mixHexColors(hex, '#fffaf0', 0.22);
        }
        if (luminance <= 0.32) {
            return this.mixHexColors(hex, '#fffaf0', 0.12);
        }

        return this.mixHexColors(hex, '#1f1a14', 0.18);
    }

    getLocationColor(label) {
        const normalized = this.normalizeLabelKey(label)
            .replace(/[\s/-]+/g, '_');

        if (normalized === 'checkout') {
            return '#FF8C00';
        }

        if (
            normalized === 'entrance' ||
            normalized === 'exit' ||
            normalized === 'entry_exit'
        ) {
            return '#00A3A3';
        }

        return '#2e86de';
    }

    getLabelTheme(label, attribute) {
        const normalizedAttribute = typeof attribute === 'string'
            ? attribute.trim().toLowerCase()
            : '';

        let accentColor = null;
        if (normalizedAttribute === 'category') {
            accentColor = this.getCategoryColor(label);
        } else if (normalizedAttribute === 'location') {
            accentColor = this.getLocationColor(label);
        } else if (normalizedAttribute === 'custom') {
            accentColor = '#8a5a2b';
        } else if (normalizedAttribute) {
            accentColor = '#8a5a2b';
        }

        if (!accentColor) return null;

        return {
            accentColor,
            borderColor: accentColor,
            backgroundColor: this.hexToRgba(accentColor, 0.12),
            pickerBorderColor: this.hexToRgba(accentColor, 0.45),
            pickerBackgroundColor: this.hexToRgba(accentColor, 0.12),
            labelColor: this.getAnnotationTextColor(accentColor),
            labelTextColor: this.getReadableTextColor(accentColor),
        };
    }

    getAnnotationBoxColors(box) {
        if (!box || !box.attribute) return null;
        return this.getLabelTheme(box.label, box.attribute);
    }

    getAnnotationLabelLayout(label, boxWidthPx, boxHeightPx) {
        const text = typeof label === 'string' ? label.trim() : '';
        if (!text) {
            return { orientation: 'horizontal' };
        }

        if (!this._annotationMeasureContext) {
            const measureCanvas = document.createElement('canvas');
            this._annotationMeasureContext = measureCanvas.getContext('2d');
        }

        const ctx = this._annotationMeasureContext;
        if (!ctx) {
            return { orientation: 'horizontal' };
        }

        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, sans-serif';
        const textWidth = ctx.measureText(text).width;
        const horizontalPadding = 14;
        const verticalPadding = 14;
        const maxHorizontalWidth = Math.max(0, boxWidthPx - horizontalPadding);
        const maxHorizontalHeight = Math.max(0, boxHeightPx - verticalPadding);
        const estimatedLineHeight = 16;
        const maxVerticalWidth = Math.max(0, boxWidthPx - 10);
        const maxVerticalHeight = Math.max(0, boxHeightPx - 10);

        // Prefer horizontal layout whenever it already fits.
        if (textWidth <= maxHorizontalWidth && estimatedLineHeight <= maxHorizontalHeight) {
            return { orientation: 'horizontal' };
        }

        const rotatedFits = textWidth <= maxVerticalHeight && estimatedLineHeight <= maxVerticalWidth;
        if (rotatedFits) {
            return { orientation: 'vertical' };
        }

        return boxHeightPx > boxWidthPx ? { orientation: 'vertical' } : { orientation: 'horizontal' };
    }

    populateAnnotationLabelContent(labelEl, text, orientation) {
        labelEl.textContent = '';
        if (!text) return;

        labelEl.textContent = text;
    }

    applyAnnotationBoxColors(box, boxEl, labelEl) {
        const colors = this.getAnnotationBoxColors(box);
        if (!colors || !boxEl || !labelEl) return;

        boxEl.style.setProperty('--annotation-border-color', colors.borderColor);
        boxEl.style.setProperty('--annotation-box-bg', colors.backgroundColor);
        labelEl.style.setProperty('--annotation-label-color', colors.labelColor);
    }

    applyLabelPickerButtonColor(button, label, attribute) {
        if (!button) return;

        const theme = this.getLabelTheme(label, attribute);
        if (!theme) return;

        button.style.borderColor = theme.pickerBorderColor;
        button.style.background = theme.pickerBackgroundColor;
        button.style.boxShadow = `inset 3px 0 0 ${theme.accentColor}`;
    }

    getMapAnnotationColors(annotation) {
        if (!annotation || typeof annotation !== 'object') return null;

        const category = typeof annotation.category === 'string'
            ? annotation.category.trim()
            : '';
        const label = typeof annotation.label === 'string'
            ? annotation.label.trim()
            : '';

        const categoryColor = this.getCategoryColor(category) || this.getCategoryColor(label);
        if (!categoryColor) return null;

        return {
            borderColor: this.hexToRgba(categoryColor, 0.42),
            backgroundColor: this.hexToRgba(categoryColor, 0.16),
            dotColor: categoryColor,
            textColor: this.getReadableTextColor(categoryColor) === '#1f1f1f'
                ? '#2c2419'
                : '#fffefb',
        };
    }

    applyMapAnnotationColors(annotation, element) {
        if (!annotation || !element) return;

        const colors = this.getMapAnnotationColors(annotation);
        if (!colors) return;

        element.classList.add('map-annotation--custom-color');
        element.style.setProperty('--map-annotation-border-color', colors.borderColor);
        element.style.setProperty('--map-annotation-bg', colors.backgroundColor);
        element.style.setProperty('--map-annotation-dot-color', colors.dotColor);
        element.style.setProperty('--map-annotation-text-color', colors.textColor);
    }

    showLabelPicker(screenX, screenY) {
        // Remove any existing picker without clearing pendingBox
        const existing = document.getElementById('labelPicker');
        if (existing) existing.remove();
        if (this._labelPickerKeyHandler) {
            document.removeEventListener('keydown', this._labelPickerKeyHandler);
            this._labelPickerKeyHandler = null;
        }
        const picker = document.createElement('div');
        picker.id = 'labelPicker';
        picker.className = 'label-picker';

        const mapPanel = document.getElementById('mapPanel');
        const rect = mapPanel.getBoundingClientRect();
        const initialLeft = Math.max(4, Math.min(rect.width - 4, screenX - rect.left + 4));
        const initialTop = Math.max(4, Math.min(rect.height - 4, screenY - rect.top + 4));
        picker.style.left = `${initialLeft}px`;
        picker.style.top = `${initialTop}px`;

        const clampPickerPosition = () => {
            const pickerWidth = picker.offsetWidth;
            const pickerHeight = picker.offsetHeight;
            const maxLeft = Math.max(4, rect.width - pickerWidth - 4);
            const maxTop = Math.max(4, rect.height - pickerHeight - 4);
            const currentLeft = parseFloat(picker.style.left) || 4;
            const currentTop = parseFloat(picker.style.top) || 4;

            picker.style.left = `${Math.max(4, Math.min(maxLeft, currentLeft))}px`;
            picker.style.top = `${Math.max(4, Math.min(maxTop, currentTop))}px`;
        };

        const schedulePickerClamp = () => {
            requestAnimationFrame(clampPickerPosition);
        };

        const groupNames = this.configuredLabelGroupNames;
        const hasGroups = groupNames.length > 0;
        if (!hasGroups) picker.classList.add('label-picker--no-tabs');
        let activeTabIndex = 0;
        const tabPanels = [];

        // Helper: get the labels array for the currently active tab
        const getActiveLabels = () => {
            if (!hasGroups) return this.configuredLabels;
            return this.configuredLabelGroups[groupNames[activeTabIndex]] || [];
        };

        // --- Tab bar ---
        let tabBar = null;
        if (hasGroups) {
            tabBar = document.createElement('div');
            tabBar.className = 'label-picker-tabs';
            for (let t = 0; t < groupNames.length; t++) {
                const tab = document.createElement('button');
                tab.className = 'label-picker-tab' + (t === 0 ? ' active' : '');
                tab.textContent = groupNames[t];
                tab.dataset.tabIndex = t;
                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    switchTab(t);
                });
                tabBar.appendChild(tab);
            }
            picker.appendChild(tabBar);
        }

        // --- Tab panels ---
        const panelContainer = document.createElement('div');
        panelContainer.className = 'label-picker-panels';

        if (hasGroups) {
            for (let t = 0; t < groupNames.length; t++) {
                const panel = document.createElement('div');
                panel.className = 'label-picker-panel' + (t === 0 ? ' active' : '');
                const labels = this.configuredLabelGroups[groupNames[t]] || [];
                for (let i = 0; i < labels.length; i++) {
                    const label = labels[i];
                    const btn = document.createElement('button');
                    btn.className = 'label-picker-btn';
                    this.applyLabelPickerButtonColor(btn, label, groupNames[t]);
                    const numSpan = document.createElement('span');
                    numSpan.className = 'label-picker-num';
                    numSpan.textContent = `${i + 1}`;
                    btn.appendChild(numSpan);
                    btn.appendChild(document.createTextNode(label));
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.commitPendingBox(label, groupNames[t]);
                    });
                    panel.appendChild(btn);
                }
                panelContainer.appendChild(panel);
                tabPanels.push(panel);
            }
        } else {
            // Flat list fallback (no groups)
            const panel = document.createElement('div');
            panel.className = 'label-picker-panel active';
            for (let i = 0; i < this.configuredLabels.length; i++) {
                const label = this.configuredLabels[i];
                const btn = document.createElement('button');
                btn.className = 'label-picker-btn';
                this.applyLabelPickerButtonColor(btn, label, '');
                const numSpan = document.createElement('span');
                numSpan.className = 'label-picker-num';
                numSpan.textContent = `${i + 1}`;
                btn.appendChild(numSpan);
                btn.appendChild(document.createTextNode(label));
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.commitPendingBox(label, '');
                });
                panel.appendChild(btn);
            }
            panelContainer.appendChild(panel);
            tabPanels.push(panel);
        }
        picker.appendChild(panelContainer);

        // --- Switch tab ---
        const switchTab = (index) => {
            activeTabIndex = index;
            tabPanels.forEach((p, i) => p.classList.toggle('active', i === index));
            if (tabBar) {
                tabBar.querySelectorAll('.label-picker-tab').forEach((t, i) =>
                    t.classList.toggle('active', i === index));
            }
            panelContainer.scrollTop = 0;
            schedulePickerClamp();
        };

        // --- Keyboard shortcut handler ---
        this._labelPickerKeyHandler = (e) => {
            // Don't intercept when typing in the custom label input
            if (e.target && e.target.classList.contains('label-picker-input')) return;
            if (e.key === 'Escape') {
                this.cancelPendingBox();
                return;
            }
            // TAB to switch between tabs
            if (e.key === 'Tab' && hasGroups) {
                e.preventDefault();
                e.stopPropagation();
                const next = e.shiftKey
                    ? (activeTabIndex - 1 + groupNames.length) % groupNames.length
                    : (activeTabIndex + 1) % groupNames.length;
                switchTab(next);
                return;
            }
            // digit keys 1-9 select labels from active tab
            const digit = parseInt(e.key, 10);
            const activeLabels = getActiveLabels();
            if (digit >= 1 && digit <= activeLabels.length) {
                e.preventDefault();
                e.stopPropagation();
                const attr = hasGroups ? groupNames[activeTabIndex] : '';
                this.commitPendingBox(activeLabels[digit - 1], attr);
            }
        };
        document.addEventListener('keydown', this._labelPickerKeyHandler);

        // --- Custom label input ---
        const customRow = document.createElement('div');
        customRow.className = 'label-picker-custom';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'label-picker-input';
        input.placeholder = 'Custom label...';
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const attr = hasGroups ? groupNames[activeTabIndex] : '';
                this.commitPendingBox(input.value.trim(), attr);
            }
            else if (e.key === 'Escape') this.cancelPendingBox();
        });
        const okBtn = document.createElement('button');
        okBtn.className = 'label-picker-ok';
        okBtn.textContent = '✓';
        okBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const attr = hasGroups ? groupNames[activeTabIndex] : '';
            this.commitPendingBox(input.value.trim(), attr);
        });
        customRow.appendChild(input);
        customRow.appendChild(okBtn);
        picker.appendChild(customRow);
        mapPanel.appendChild(picker);

        clampPickerPosition();

        // Don't auto-focus the input so digit keys can trigger label shortcuts.
    }

    hideLabelPicker() {
        const existing = document.getElementById('labelPicker');
        if (existing) existing.remove();
        if (this._labelPickerKeyHandler) {
            document.removeEventListener('keydown', this._labelPickerKeyHandler);
            this._labelPickerKeyHandler = null;
        }
        this.pendingBox = null;
    }

    commitPendingBox(label, attribute) {
        if (this.pendingBox) {
            const { x, y, width, height } = this.pendingBox;
            this.annotations.push({
                id: this.nextAnnotationId++,
                x, y, width, height,
                label: label || '',
                attribute: attribute || ''
            });
            // Persist any new custom label
            if (label && !this.configuredLabels.includes(label)) {
                this.saveCustomLabel(label);
            }
            this.hasUnsavedChanges = true;
        }
        this.isBoxDrawMode = false;
        this.canvas.style.cursor = 'grab';
        this.hideLabelPicker();
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    cancelPendingBox() {
        this.isBoxDrawMode = false;
        this.canvas.style.cursor = 'grab';
        this.hideLabelPicker();
        this.renderAnnotationBoxes();
    }

    applyRotation(angleDeg) {
        const rad = angleDeg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const center = this.computeDataCenter();
        const cx = center.x;
        const cy = center.y;

        // Rotate helper for a 2D point around center
        const rotate = (x, y) => [
            cx + (x - cx) * cos - (y - cy) * sin,
            cy + (x - cx) * sin + (y - cy) * cos
        ];

        // Rotate camera positions and directions
        for (const cam of this.cameras) {
            const [nx, ny] = rotate(cam.position[0], cam.position[1]);
            cam.position[0] = nx;
            cam.position[1] = ny;
            if (typeof cam.direction === 'number') {
                cam.direction = (cam.direction + angleDeg) % 360;
                if (cam.direction < 0) cam.direction += 360;
            }
            // compassDirection is the true compass bearing — do not rotate with layout
        }

        // Rotate point cloud
        for (const pt of this.pointCloud) {
            const [nx, ny] = rotate(pt[0], pt[1]);
            pt[0] = nx;
            pt[1] = ny;
        }

        // Rotate map annotations
        for (const ann of this.mapAnnotations) {
            if (Array.isArray(ann.position) && ann.position.length >= 2) {
                const [nx, ny] = rotate(ann.position[0], ann.position[1]);
                ann.position[0] = nx;
                ann.position[1] = ny;
            }
        }

        // Rotate annotation boxes (rotate center point, keep width/height unchanged)
        for (const box of this.annotations) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const [ncx, ncy] = rotate(cx, cy);
            box.x = ncx - box.width / 2;
            box.y = ncy - box.height / 2;
        }

        this.rotationAngle += angleDeg;
        this.hasUnsavedChanges = true;
        this.syncRotationSlider();

        // Update selected camera indicator to match rotated position
        if (this.selectedCamera !== null) {
            const newPose = this.getCameraPose(this.selectedCamera);
            if (newPose) {
                this.selectedIndicatorPose = { ...newPose };
                this.selectedIndicatorTargetPose = { ...newPose };
            }
        }

        // Refresh all rendering
        this.uploadPointCloud();
        this.updateVisibleCameras();
        this.fitView();
        this.render();
        this.renderAnnotationBoxes();
    }

    syncRotationSlider() {
        const slider = document.getElementById('rotationSlider');
        const label = document.getElementById('rotationValue');
        if (slider && label) {
            // Normalize to -180..180
            let v = this.rotationAngle % 360;
            if (v > 180) v -= 360;
            if (v < -180) v += 360;
            slider.value = Math.round(v);
            label.textContent = Math.round(v) + '°';
        }
        // Rotate north indicator to show where North points on the rotated map
        const northEl = document.getElementById('northIndicator');
        if (northEl) {
            northEl.style.transform = `rotate(${this.rotationAngle}deg)`;
        }
    }

    renderAnnotationBoxes() {
        const layer = document.getElementById('mapAnnotationLayer');
        if (!layer) return;

        // Remove existing annotation box elements (keep map-annotation labels)
        layer.querySelectorAll('.annotation-box').forEach(el => el.remove());

        const fragment = document.createDocumentFragment();

        // Render saved annotation boxes
        for (const box of this.annotations) {
            const el = this.createAnnotationBoxElement(box);
            if (el) fragment.appendChild(el);
        }

        // Render live preview while drawing
        if (this.isDrawingBox && this.drawStartWorld && this.drawCurrentWorld) {
            const s = this.drawStartWorld;
            const c = this.drawCurrentWorld;
            const previewBox = {
                x: Math.min(s.x, c.x),
                y: Math.min(s.y, c.y),
                width: Math.abs(c.x - s.x),
                height: Math.abs(c.y - s.y),
                label: ''
            };
            const el = this.createAnnotationBoxElement(previewBox);
            if (el) {
                el.classList.add('annotation-box--preview');
                fragment.appendChild(el);
            }
        }

        // Render pending box while label picker is open
        if (this.pendingBox) {
            const el = this.createAnnotationBoxElement({ ...this.pendingBox, label: '' });
            if (el) {
                el.classList.add('annotation-box--preview');
                fragment.appendChild(el);
            }
        }

        layer.appendChild(fragment);
    }

    createAnnotationBoxElement(box) {
        const topLeft = this.worldToScreen(box.x, box.y);
        const bottomRight = this.worldToScreen(box.x + box.width, box.y + box.height);

        const left = Math.min(topLeft.x, bottomRight.x);
        const top = Math.min(topLeft.y, bottomRight.y);
        const w = Math.abs(bottomRight.x - topLeft.x);
        const h = Math.abs(bottomRight.y - topLeft.y);

        // Skip if entirely off-screen
        if (left + w < -10 || top + h < -10 || left > topLeft.width + 10 || top > topLeft.height + 10) {
            return null;
        }

        const el = document.createElement('div');
        el.className = 'annotation-box';
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;

        // Attribute-based color class
        if (box.attribute) {
            el.classList.add(`annotation-box--${box.attribute}`);
        }

        if (box.id !== undefined) {
            el.dataset.annotationId = box.id;
            if (box.id === this.selectedAnnotation) {
                el.classList.add('annotation-box--selected');
            }
        }

        const labelEl = document.createElement('div');
        labelEl.className = 'annotation-label';
        const labelText = box.label || (box.id !== undefined ? `#${box.id}` : '');
        const labelLayout = this.getAnnotationLabelLayout(labelText, w, h);
        labelEl.classList.add(`annotation-label--${labelLayout.orientation}`);
        if (labelLayout.orientation === 'vertical') {
            labelEl.style.maxWidth = `${Math.max(0, h - 8)}px`;
            labelEl.style.maxHeight = `${Math.max(0, w - 8)}px`;
        } else {
            labelEl.style.maxWidth = `${Math.max(0, w - 10)}px`;
            labelEl.style.maxHeight = `${Math.max(0, h - 10)}px`;
        }
        if (!labelText) {
            labelEl.classList.add('annotation-label--empty');
        }
        this.populateAnnotationLabelContent(labelEl, labelText, labelLayout.orientation);

        if (box.id !== this.selectedAnnotation) {
            this.applyAnnotationBoxColors(box, el, labelEl);
        }

        // Add × delete button on selected box
        if (box.id !== undefined && box.id === this.selectedAnnotation) {
            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'annotation-delete';
            deleteBtn.textContent = '×';
            deleteBtn.title = 'Delete annotation';
            deleteBtn.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
            });
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.deleteAnnotation(box.id);
            });
            el.appendChild(deleteBtn);
        }

        el.appendChild(labelEl);

        // Resize handles on selected box
        if (box.id !== undefined && box.id === this.selectedAnnotation && this.annotationMode) {
            const handles = ['nw', 'ne', 'se', 'sw'];
            for (const pos of handles) {
                const handle = document.createElement('div');
                handle.className = `annotation-resize annotation-resize--${pos}`;
                handle.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    this.startAnnotationResize(box.id, pos, e);
                });
                el.appendChild(handle);
            }
        }

        // Drag to move and click to select/deselect
        if (box.id !== undefined && this.annotationMode) {
            el.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                const world = this.screenToWorld(e.clientX, e.clientY);
                const ann = this.annotations.find(a => a.id === box.id);
                if (!ann) return;
                this.isDraggingAnnotation = false;
                this.dragAnnotationId = box.id;
                this.dragAnnotationOffset = { dx: world.x - ann.x, dy: world.y - ann.y };
                this._dragStartScreen = { x: e.clientX, y: e.clientY };
                this._dragMoved = false;

                const onMouseMove = (me) => {
                    const dx = me.clientX - this._dragStartScreen.x;
                    const dy = me.clientY - this._dragStartScreen.y;
                    if (!this._dragMoved && (dx * dx + dy * dy) > 9) {
                        this._dragMoved = true;
                        this.isDraggingAnnotation = true;
                        this.selectedAnnotation = box.id;
                    }
                    if (this._dragMoved) {
                        const w = this.screenToWorld(me.clientX, me.clientY);
                        ann.x = w.x - this.dragAnnotationOffset.dx;
                        ann.y = w.y - this.dragAnnotationOffset.dy;
                        this.renderAnnotationBoxes();
                    }
                };
                const onMouseUp = (me) => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    if (!this._dragMoved) {
                        // No drag -> toggle selection
                        this.selectedAnnotation = this.selectedAnnotation === box.id ? null : box.id;
                    }
                    this.isDraggingAnnotation = false;
                    this.dragAnnotationId = null;
                    this.dragAnnotationOffset = null;
                    if (this._dragMoved) {
                        this.hasUnsavedChanges = true;
                    }
                    this.renderAnnotationBoxes();
                };
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }

        return el;
    }

    startAnnotationResize(id, handlePos, e) {
        const ann = this.annotations.find(a => a.id === id);
        if (!ann) return;
        const startWorld = this.screenToWorld(e.clientX, e.clientY);
        const origX = ann.x, origY = ann.y, origW = ann.width, origH = ann.height;
        let resized = false;

        const onMouseMove = (me) => {
            const cur = this.screenToWorld(me.clientX, me.clientY);
            const dx = cur.x - startWorld.x;
            const dy = cur.y - startWorld.y;
            let nx = origX, ny = origY, nw = origW, nh = origH;

            if (handlePos.includes('w')) { nx = origX + dx; nw = origW - dx; }
            if (handlePos.includes('e')) { nw = origW + dx; }
            if (handlePos.includes('n')) { ny = origY + dy; nh = origH - dy; }
            if (handlePos.includes('s')) { nh = origH + dy; }

            // Prevent negative size — flip origin if dragged past opposite edge
            if (nw < 0) { nx = nx + nw; nw = -nw; }
            if (nh < 0) { ny = ny + nh; nh = -nh; }

            ann.x = nx; ann.y = ny; ann.width = nw; ann.height = nh;
            resized = true;
            this.renderAnnotationBoxes();
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (resized) {
                this.hasUnsavedChanges = true;
            }
            this.renderAnnotationBoxes();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    deleteAnnotation(id) {
        const ann = this.annotations.find(a => a.id === id);
        const name = ann && ann.label ? `"${ann.label}"` : `#${id}`;
        if (!confirm(`Delete annotation ${name}?`)) return;
        if (this.selectedAnnotation === id) this.selectedAnnotation = null;
        this.annotations = this.annotations.filter(a => a.id !== id);
        this.hasUnsavedChanges = true;
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    hitTestAnnotation(wx, wy) {
        // Return the id of the topmost annotation whose bounding box contains (wx, wy), or null.
        for (let i = this.annotations.length - 1; i >= 0; i--) {
            const a = this.annotations[i];
            if (wx >= a.x && wx <= a.x + a.width && wy >= a.y && wy <= a.y + a.height) {
                return a.id;
            }
        }
        return null;
    }

    getExportGzipFileNameByParentDir() {
        const fallback = 'viewer_label.json.gz';
        const pathname = (window.location && window.location.pathname) || '';
        const segments = pathname.split('/').filter(Boolean);

        if (segments.length === 0) return fallback;

        const last = segments[segments.length - 1];
        const currentIsFile = /\.[A-Za-z0-9]+$/.test(last);
        const currentDirIndex = currentIsFile ? segments.length - 2 : segments.length - 1;
        const parentDirIndex = currentDirIndex - 1;

        let rawName = '';
        if (parentDirIndex >= 0) {
            rawName = segments[parentDirIndex];
        } else if (currentDirIndex >= 0) {
            // 路径层级不够时回退到当前目录，保证仍有可读文件名。
            rawName = segments[currentDirIndex];
        }

        const decoded = (() => {
            try {
                return decodeURIComponent(rawName || '');
            } catch (e) {
                return rawName || '';
            }
        })();

        const safe = decoded
            .replace(/[^0-9A-Za-z._-]+/g, '_')
            .replace(/^[._-]+|[._-]+$/g, '');

        const base = safe || 'label';
        // Ensure viewer_ prefix
        return base.startsWith('viewer_') ? `${base}.json.gz` : `viewer_${base}.json.gz`;
    }

    getExportBaseNameByParentDir() {
        const gzName = this.getExportGzipFileNameByParentDir();
        return gzName.replace(/\.json\.gz$/i, '').replace(/\.gz$/i, '').replace(/\.json$/i, '');
    }

    getMapExportBounds() {
        const bounds = this.getDataBoundsWorld();
        if (!bounds) return null;

        const width = Math.max(bounds.maxX - bounds.minX, 1);
        const height = Math.max(bounds.maxY - bounds.minY, 1);
        const padRatio = 0.06;
        const padX = Math.max(width * padRatio, 1);
        const padY = Math.max(height * padRatio, 1);

        return {
            minX: bounds.minX - padX,
            minY: bounds.minY - padY,
            maxX: bounds.maxX + padX,
            maxY: bounds.maxY + padY,
            width: width + padX * 2,
            height: height + padY * 2,
        };
    }

    createMapExportCanvas(maxLongEdge = 2048) {
        const bounds = this.getMapExportBounds();
        if (!bounds) return null;

        const aspect = bounds.width / bounds.height;
        let width;
        let height;

        if (aspect >= 1) {
            width = maxLongEdge;
            height = Math.max(1, Math.round(width / aspect));
        } else {
            height = maxLongEdge;
            width = Math.max(1, Math.round(height * aspect));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return { canvas, bounds };
    }

    renderMapToCanvas(targetCanvas) {
        const bounds = this.getMapExportBounds();
        if (!bounds || !targetCanvas) return false;

        const ctx = targetCanvas.getContext('2d');
        if (!ctx) return false;

        const bgColor = 'rgb(243, 236, 217)';
        const pointColor = 'rgba(56, 56, 56, 0.85)';
        const pathColor = 'rgba(102, 102, 102, 0.72)';
        const cameraColor = 'rgba(22, 61, 139, 1)';
        const overlayColor = 'rgba(250, 115, 46, 1)';
        const directionColor = 'rgba(204, 26, 26, 0.95)';

        const width = targetCanvas.width;
        const height = targetCanvas.height;
        const scale = Math.min(width / bounds.width, height / bounds.height);
        const offsetX = (width - bounds.width * scale) / 2;
        const offsetY = (height - bounds.height * scale) / 2;

        const worldToCanvas = (x, y) => ({
            x: offsetX + (x - bounds.minX) * scale,
            // Keep export orientation consistent with the on-screen map, where
            // larger world Y values appear lower on the canvas.
            y: offsetY + (y - bounds.minY) * scale,
        });

        ctx.save();
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);

        if (this.showPointCloud && this.pointCloud.length > 0) {
            const radius = Math.max(1, Math.round(1.5 * (width / 1600)));
            ctx.fillStyle = pointColor;
            for (const pt of this.pointCloud) {
                const p = worldToCanvas(pt[0], pt[1]);
                ctx.beginPath();
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        if (this.showCameras) {
            const baseCameras = this.cameras.filter(c => !c.isOverlay);
            const overlayCameras = this.cameras.filter(c => c.isOverlay);

            if (baseCameras.length > 1) {
                ctx.strokeStyle = pathColor;
                ctx.lineWidth = Math.max(2, Math.round(width / 512));
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.beginPath();
                baseCameras.forEach((cam, index) => {
                    const p = worldToCanvas(cam.position[0], cam.position[1]);
                    if (index === 0) {
                        ctx.moveTo(p.x, p.y);
                    } else {
                        ctx.lineTo(p.x, p.y);
                    }
                });
                ctx.stroke();
            }

            const directionLength = Math.max(12, width / 64);
            const directionThickness = Math.max(4, width / 320);
            ctx.strokeStyle = directionColor;
            ctx.fillStyle = directionColor;
            ctx.lineWidth = directionThickness;
            ctx.lineCap = 'round';

            for (const cam of baseCameras) {
                const start = worldToCanvas(cam.position[0], cam.position[1]);
                const dir = this.getMapDirection(cam) * Math.PI / 180;
                const end = {
                    x: start.x + Math.sin(dir) * directionLength,
                    y: start.y - Math.cos(dir) * directionLength,
                };

                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();

                const headLength = Math.max(6, directionLength * 0.28);
                const headAngle = Math.PI / 7;
                ctx.beginPath();
                ctx.moveTo(end.x, end.y);
                ctx.lineTo(
                    end.x - Math.sin(dir - headAngle) * headLength,
                    end.y + Math.cos(dir - headAngle) * headLength
                );
                ctx.lineTo(
                    end.x - Math.sin(dir + headAngle) * headLength,
                    end.y + Math.cos(dir + headAngle) * headLength
                );
                ctx.closePath();
                ctx.fill();
            }

            const cameraRadius = Math.max(5, width / 170);
            const cameraOutline = Math.max(2, width / 680);
            for (const cam of baseCameras) {
                const p = worldToCanvas(cam.position[0], cam.position[1]);
                ctx.beginPath();
                ctx.arc(p.x, p.y, cameraRadius, 0, Math.PI * 2);
                ctx.fillStyle = cameraColor;
                ctx.fill();
                ctx.lineWidth = cameraOutline;
                ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
                ctx.stroke();
            }

            const overlayRadius = cameraRadius * 1.1;
            for (const cam of overlayCameras) {
                const p = worldToCanvas(cam.position[0], cam.position[1]);
                ctx.beginPath();
                ctx.arc(p.x, p.y, overlayRadius, 0, Math.PI * 2);
                ctx.fillStyle = overlayColor;
                ctx.fill();
                ctx.lineWidth = cameraOutline;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
                ctx.stroke();
            }
        }

        ctx.restore();
        return true;
    }

    async exportMapPng() {
        const exportTarget = this.createMapExportCanvas();
        if (!exportTarget) {
            alert('No map data available to export.');
            return;
        }

        const { canvas } = exportTarget;
        const rendered = this.renderMapToCanvas(canvas);
        if (!rendered) {
            alert('Failed to render map for PNG export.');
            return;
        }

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) {
            alert('Failed to encode PNG.');
            return;
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.getExportBaseNameByParentDir()}_map.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async exportAnnotatedData() {
        // Free decoded image data from cache before heavy memory ops
        // (large companion photo images can cause major GC during stringify)
        this.imageCache.clear();
        // Yield to let GC run and allow browser to render "Saving…" button state
        await new Promise(r => setTimeout(r, 50));

        const data = {
            pointCloud: this.pointCloud,
            cameras: this.cameras.map(cam => ({ ...cam })),
            mapAnnotations: this.mapAnnotations,
            metadata: this.metadata || {},
            annotations: this.annotations.map(a => ({ ...a })),
            rotationApplied: this.rotationAngle,
        };

        // Preserve original fields
        if (this.matchPairs.length > 0) data.matchPairs = this.matchPairs;
        if (this.trackPairs.length > 0) data.trackPairs = this.trackPairs;
        if (Object.keys(this.recogData).length > 0) data.recogData = this.recogData;

        // Save calibration / scale bar data
        if (this.baseRatio !== null) {
            data.scaleCalibration = {
                baseRatio: this.baseRatio,
                unit: this.calibrationUnit,
            };
        }

        const json = JSON.stringify(data);

        // Gzip compress
        let gzipBytes;
        try {
            const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
            gzipBytes = await new Response(stream).arrayBuffer();
        } catch (e) {
            alert('Gzip compression not supported by this browser.');
            return;
        }

        // Try to save directly to server
        const saveFileName = this.loadedDataFileName || this.getExportGzipFileNameByParentDir();
        try {
            const saveUrl = this.saveBaseUrl + '/save-data?filename=' + encodeURIComponent(saveFileName);
            const resp = await fetch(saveUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/gzip' },
                body: gzipBytes,
            });
            if (resp.ok) {
                const btn = document.getElementById('saveJsonBtn');
                btn.textContent = '✓ Saved';
                btn.style.color = 'green';
                setTimeout(() => { btn.textContent = 'Save JSON'; btn.style.color = ''; }, 2000);
                this.hasUnsavedChanges = false;
                return;
            }
        } catch (e) {
            // Server not running — fall through to download
        }

        // Fallback: download the gz file (按 URL 上级目录名命名)
        const blob = new Blob([gzipBytes], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.getExportGzipFileNameByParentDir();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.hasUnsavedChanges = false;
    }

    // ========================================================================
    // Event Handling
    // ========================================================================

    setupEventListeners() {
        window.addEventListener('beforeunload', (e) => {
            if (!this.hasUnsavedChanges) return;
            e.preventDefault();
            e.returnValue = '';
        });

        // Map canvas events
        this.canvas.addEventListener('mousedown', this.onMapMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.onMapMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.onMapMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.onMapMouseLeave.bind(this));
        document.addEventListener('mousemove', this.onMapDocumentMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMapDocumentMouseUp.bind(this));
        this.canvas.addEventListener('dblclick', this.onMapDoubleClick.bind(this));
        this.canvas.addEventListener('wheel', this.onMapWheel.bind(this), { passive: false });
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        // Touch support for map
        this.canvas.addEventListener('touchstart', this.onMapTouchStart.bind(this), { passive: false });
        this.canvas.addEventListener('touchmove', this.onMapTouchMove.bind(this), { passive: false });
        this.canvas.addEventListener('touchend', this.onMapTouchEnd.bind(this));

        // Image panel events
        const imageContainer = document.getElementById('imageContainer');
        imageContainer.addEventListener('wheel', this.onImageWheel.bind(this), { passive: false });
        imageContainer.addEventListener('mousedown', this.onImageMouseDown.bind(this));
        imageContainer.addEventListener('mousemove', this.onImageMouseMove.bind(this));
        imageContainer.addEventListener('mouseup', this.onImageMouseUp.bind(this));
        imageContainer.addEventListener('mouseleave', this.onImageMouseUp.bind(this));
        imageContainer.addEventListener('dblclick', this.onImageDoubleClick.bind(this));

        // Timeline events
        const timeline = document.getElementById('timeline');
        timeline.addEventListener('mousedown', this.onTimelineMouseDown.bind(this));
        document.addEventListener('mousemove', this.onTimelineMouseMove.bind(this));
        document.addEventListener('mouseup', this.onTimelineMouseUp.bind(this));

        // Timeline touch
        timeline.addEventListener('touchstart', this.onTimelineTouchStart.bind(this), { passive: false });
        document.addEventListener('touchmove', this.onTimelineTouchMove.bind(this), { passive: false });
        document.addEventListener('touchend', this.onTimelineTouchEnd.bind(this));

        // Keyboard
        document.addEventListener('keydown', this.onKeyDown.bind(this));

        // Window resize
        window.addEventListener('resize', () => {
            this.resize();
            this.updateVisibleCameras();
            this.render();
            this.refitImage();
            if (this.selectedCamera !== null) {
                this.updateTimelinePosition(this.selectedCamera);
            }
        });

        // Toolbar buttons
        document.getElementById('fitViewBtn').addEventListener('click', () => {
            this.fitView();
            this.render();
        });

        document.getElementById('showPointCloud').addEventListener('change', (e) => {
            this.showPointCloud = e.target.checked;
            e.target.blur();
            this.render();
        });

        document.getElementById('showCameras').addEventListener('change', (e) => {
            this.showCameras = e.target.checked;
            e.target.blur();
            if (!this.showCameras) {
                this.clearMapHoverState();
            }
            this.render();
        });

        document.getElementById('useCompassForMap').addEventListener('change', (e) => {
            this.useCompassForMap = e.target.checked;
            e.target.blur();

            if (this.selectedCamera !== null) {
                const pose = this.getCameraPose(this.selectedCamera);
                if (pose) {
                    this.selectedIndicatorPose = { ...pose };
                    this.selectedIndicatorTargetPose = { ...pose };
                    this.isAnimatingSelectedIndicator = false;
                }
            }

            this.updateVisibleCameras();
            this.updateFOVWedge();
            this.render();
        });

        document.getElementById('showRecogDetails').addEventListener('change', (e) => {
            this.showRecogDetails = e.target.checked;
            e.target.blur();
            if (this.selectedCamera !== null) {
                const cam = this.cameras.find(c => c.id === this.selectedCamera);
                this.updateImageRecogBar(cam || null);
            }
        });

        document.getElementById('showDebugMatches').addEventListener('change', (e) => {
            this.showDebugMatches = e.target.checked;
            e.target.blur();
            this.updateMatchLines();
            this.render();
        });

        document.getElementById('debugSourceSelect').addEventListener('change', (e) => {
            this.debugConnectionSource = e.target.value === 'tracks' ? 'tracks' : 'matches';
            e.target.blur();
            this.updateMatchLines();
            this.render();
        });

        document.getElementById('helpBtn').addEventListener('click', () => {
            document.getElementById('helpOverlay').classList.toggle('visible');
        });

        // Calibration mode toggle
        if (!this.readOnly) {
            document.getElementById('calibrateBtn').addEventListener('click', () => {
                this.toggleCalibrationMode();
            });

            // Companion mode toggle
            document.getElementById('companionModeBtn').addEventListener('click', () => {
                this.toggleCompanionMode();
            });

            // Calibration dialog buttons
            document.getElementById('calibrateConfirmBtn').addEventListener('click', () => {
                this.confirmCalibration();
            });
            document.getElementById('calibrateCancelBtn').addEventListener('click', () => {
                this.cancelCalibration();
            });
            document.getElementById('calibrateDistInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.confirmCalibration();
                if (e.key === 'Escape') this.cancelCalibration();
            });

            // Annotation mode toggle
            document.getElementById('annotationModeBtn').addEventListener('click', () => {
                this.toggleAnnotationMode();
            });

            const rotationSlider = document.getElementById('rotationSlider');
            const rotationValue = document.getElementById('rotationValue');
            let sliderPrevValue = 0;
            rotationSlider.addEventListener('input', () => {
                rotationValue.textContent = rotationSlider.value + '°';
            });
            rotationSlider.addEventListener('mousedown', () => {
                sliderPrevValue = parseFloat(rotationSlider.value);
            });
            rotationSlider.addEventListener('change', () => {
                const newVal = parseFloat(rotationSlider.value);
                const delta = newVal - sliderPrevValue;
                if (!isNaN(delta) && delta !== 0) {
                    this.applyRotation(delta);
                }
            });

            document.getElementById('rotateMinusBtn').addEventListener('click', () => {
                this.applyRotation(-1);
            });
            document.getElementById('rotatePlusBtn').addEventListener('click', () => {
                this.applyRotation(1);
            });

            document.getElementById('exportMapPngBtn').addEventListener('click', () => {
                this.exportMapPng();
            });

            document.getElementById('saveJsonBtn').addEventListener('click', async () => {
                const btn = document.getElementById('saveJsonBtn');
                btn.textContent = 'Saving…';
                btn.disabled = true;
                await this.exportAnnotatedData();
                btn.disabled = false;
            });
        }

        document.getElementById('prevBtn').addEventListener('click', () => this.navigateCamera(-1));
        document.getElementById('nextBtn').addEventListener('click', () => this.navigateCamera(1));

        document.getElementById('deleteCompanionBtn').addEventListener('click', () => {
            if (this.annotationMode && this.selectedCamera !== null) {
                this.removeCompanionCamera(this.selectedCamera);
            }
        });

        // File input fallback
        document.getElementById('fileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const text = await file.text();
                try {
                    const data = JSON.parse(text);
                    this.loadData(data);
                } catch (err) {
                    alert('Failed to parse JSON: ' + err.message);
                }
            }
        });

        // Divider drag for split pane resize
        this.setupDivider();
    }

    // --- Map events ---

    onMapMouseDown(e) {
        this.isAnimatingMapTransition = false;

        // Calibration mode intercept
        if (this.calibrationMode) {
            if (this.onCalibrationClick(e)) return;
        }

        // Companion mode intercept: click to place companion
        if (this.companionMode && e.button === 0) {
            const world = this.screenToWorld(e.clientX, e.clientY);
            this.showCompanionDialog(world.x, world.y, e.clientX, e.clientY);
            return;
        }

        const world = this.screenToWorld(e.clientX, e.clientY);

        if (this.annotationMode && e.button === 0 && this.selectedAnnotation !== null) {
            const hitAnnotation = this.hitTestAnnotation(world.x, world.y);
            if (hitAnnotation === null) {
                this.selectedAnnotation = null;
                this.renderAnnotationBoxes();
            }
        }

        // Annotation mode + Ctrl or box draw mode: start drawing a box
        if (this.annotationMode && e.button === 0 && (this.isBoxDrawMode || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.isDrawingBox = true;
            this.drawStartWorld = world;
            this.drawCurrentWorld = world;
            return;
        }

        if (e.button === 1 || e.button === 0) {
            const hitCamera = this.hitTestCamera(world.x, world.y);

            if (hitCamera !== null && e.button === 0) {
                this.selectCamera(hitCamera);
                return;
            }

            e.preventDefault();
            this.isPanning = true;
            // Store world-space anchor for 1:1 drag
            this.dragWorldAnchor = this.screenToWorld(e.clientX, e.clientY);
            this.hideMapThumbnail();
        }
    }

    onMapMouseMove(e) {
        // Annotation mode: update box preview while drawing
        if (this.isDrawingBox) {
            this.drawCurrentWorld = this.screenToWorld(e.clientX, e.clientY);
            this.renderAnnotationBoxes();
            return;
        }

        if (this.isPanning) {
            // World-anchor approach: compute pan so anchor stays under cursor
            const rect = this.canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) * window.devicePixelRatio;
            const y = (e.clientY - rect.top) * window.devicePixelRatio;
            const ndcX = (x / this.canvas.width) * 2 - 1;
            const ndcY = (y / this.canvas.height) * 2 - 1;

            this.panX = ndcX * this.canvas.width / (2 * this.zoom) - this.dragWorldAnchor.x;
            this.panY = ndcY * this.canvas.height / (2 * this.zoom) - this.dragWorldAnchor.y;
            this.panTargetX = this.panX;
            this.panTargetY = this.panY;

            this.updateViewMatrix();
            this.updateVisibleCameras();
            this.render();
            return;
        }

        // Hover detection
        const world = this.screenToWorld(e.clientX, e.clientY);
        const hitCamera = this.hitTestCamera(world.x, world.y);
        if (hitCamera !== this.hoveredCamera) {
            this.hoveredCamera = hitCamera;
            this.canvas.style.cursor = (this.isBoxDrawMode || this.companionMode) ? 'crosshair' : (hitCamera !== null ? 'pointer' : 'grab');
            this.uploadVisibleCameras();
            this.render();

            // Map hover thumbnail
            if (hitCamera !== null) {
                this.showMapThumbnail(hitCamera, e.clientX, e.clientY);
            } else {
                this.hideMapThumbnail();
            }
        } else if (hitCamera !== null) {
            // Update popup position as mouse moves over same camera
            this.showMapThumbnail(hitCamera, e.clientX, e.clientY);
        }
    }

    onMapMouseUp(e) {
        // Annotation mode: finish drawing box
        if (this.isDrawingBox) {
            this.isDrawingBox = false;
            const start = this.drawStartWorld;
            const end = this.drawCurrentWorld || this.screenToWorld(e.clientX, e.clientY);
            this.drawStartWorld = null;
            this.drawCurrentWorld = null;

            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const width = Math.abs(end.x - start.x);
            const height = Math.abs(end.y - start.y);

            // Ignore tiny accidental clicks (less than ~3px in world coords)
            const minWorldSize = 3 / this.zoom;
            if (width < minWorldSize && height < minWorldSize) {
                this.renderAnnotationBoxes();
                return;
            }

            this.pendingBox = { x, y, width, height };
            this.showLabelPicker(e.clientX, e.clientY);
            return;
        }

        this.isPanning = false;
        this.dragWorldAnchor = null;
    }

    onMapMouseLeave() {
        this.isPanning = false;
        this.dragWorldAnchor = null;
        // Do not cancel an active box draw here.
        // When the pointer leaves the canvas during drawing, we rely on the
        // document-level mousemove/mouseup handlers to finish the interaction
        // and open the label picker normally.
        this.hideMapThumbnail();
    }

    onMapDocumentMouseMove(e) {
        if (!this.isDrawingBox && !this.isPanning) return;
        this.onMapMouseMove(e);
    }

    onMapDocumentMouseUp(e) {
        if (!this.isDrawingBox && !this.isPanning) return;
        this.onMapMouseUp(e);
    }

    onMapDoubleClick(e) {
        const world = this.screenToWorld(e.clientX, e.clientY);
        const hitCamera = this.hitTestCamera(world.x, world.y);
        if (hitCamera === null) {
            this.smoothFitView();
        }
    }

    onMapWheel(e) {
        e.preventDefault();
        this.isAnimatingMapTransition = false;

        this.zoomAnchorScreen = { x: e.clientX, y: e.clientY };
        this.zoomAnchorWorld = this.screenToWorld(e.clientX, e.clientY);

        // Larger zoom steps for more responsive feel
        const factor = e.deltaY > 0 ? 0.78 : 1.28;
        if (factor < 1 && this.areAllDataWithinCanvas()) {
            return;
        }
        this.zoomTarget = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, this.zoomTarget * factor));

        if (!this.isAnimatingZoom) {
            this.isAnimatingZoom = true;
            this.lastZoomTime = performance.now();
            requestAnimationFrame(() => this.animateZoom());
        }
    }

    animateZoom() {
        const now = performance.now();
        const dt = Math.min((now - this.lastZoomTime) / 1000, 0.05); // cap dt
        this.lastZoomTime = now;

        const dz = this.zoomTarget - this.zoom;

        if (Math.abs(dz / this.zoom) < 0.001) {
            this.zoom = this.zoomTarget;
            this.adjustPanForZoomAnchor();
            this.updateViewMatrix();
            this.updateVisibleCameras();
            this.render();
            this.isAnimatingZoom = false;
            return;
        }

        // Smooth exponential approach (~12x/sec convergence)
        const lerpFactor = 1 - Math.exp(-12 * dt);
        this.zoom += dz * lerpFactor;
        this.adjustPanForZoomAnchor();

        this.updateViewMatrix();
        this.updateVisibleCameras();
        this.render();

        requestAnimationFrame(() => this.animateZoom());
    }

    // --- Map touch events ---

    onMapTouchStart(e) {
        if (e.touches.length === 1) {
            e.preventDefault();
            const touch = e.touches[0];

            const world = this.screenToWorld(touch.clientX, touch.clientY);
            const hitCamera = this.hitTestCamera(world.x, world.y);

            if (hitCamera !== null) {
                this.selectCamera(hitCamera);
                return;
            }

            this.isPanning = true;
            this.dragWorldAnchor = this.screenToWorld(touch.clientX, touch.clientY);
        }
    }

    onMapTouchMove(e) {
        if (this.isPanning && e.touches.length === 1) {
            e.preventDefault();
            const touch = e.touches[0];

            // World-anchor approach
            const rect = this.canvas.getBoundingClientRect();
            const x = (touch.clientX - rect.left) * window.devicePixelRatio;
            const y = (touch.clientY - rect.top) * window.devicePixelRatio;
            const ndcX = (x / this.canvas.width) * 2 - 1;
            const ndcY = (y / this.canvas.height) * 2 - 1;

            this.panX = ndcX * this.canvas.width / (2 * this.zoom) - this.dragWorldAnchor.x;
            this.panY = ndcY * this.canvas.height / (2 * this.zoom) - this.dragWorldAnchor.y;
            this.panTargetX = this.panX;
            this.panTargetY = this.panY;

            this.updateViewMatrix();
            this.updateVisibleCameras();
            this.render();
        }
    }

    onMapTouchEnd() {
        this.isPanning = false;
        this.dragWorldAnchor = null;
    }

    // --- Image events ---

    onImageWheel(e) {
        e.preventDefault();
        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img || !this.imageBaseWidth) return;

        const baseZoom = this.isAnimatingImageView ? this.imageZoomTarget : this.imageZoom;
        const factor = e.deltaY > 0 ? 0.84 : 1.20;
        const newZoom = Math.max(1, Math.min(10, baseZoom * factor));
        if (newZoom === baseZoom) return;

        const rect = container.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        this.setImageZoomTargetAroundPoint(newZoom, cx, cy);
    }

    onImageMouseDown(e) {
        if (e.button !== 0) return;
        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img) return;

        this.isAnimatingImageView = false;
        this.imageZoomTarget = this.imageZoom;
        this.imageOffsetXTarget = this.imageOffsetX;
        this.imageOffsetYTarget = this.imageOffsetY;
        this.isImageDragging = true;
        this.imageDragStart = { x: e.clientX, y: e.clientY };
        this.imageDragOffset = { x: this.imageOffsetX, y: this.imageOffsetY };
        container.classList.add('dragging');
    }

    onImageMouseMove(e) {
        if (!this.isImageDragging) return;

        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img) return;

        this.imageOffsetX = this.imageDragOffset.x + (e.clientX - this.imageDragStart.x);
        this.imageOffsetY = this.imageDragOffset.y + (e.clientY - this.imageDragStart.y);

        this.clampImageOffset(container);
        this.updateImageTransform(img);
    }

    onImageMouseUp() {
        this.isImageDragging = false;
        document.getElementById('imageContainer').classList.remove('dragging');
    }

    onImageDoubleClick() {
        const container = document.getElementById('imageContainer');
        const img = this.getMainImageElement(container);
        if (!img || !this.imageBaseWidth) return;

        const targetOffsetX = (container.clientWidth - this.imageBaseWidth) / 2;
        const targetOffsetY = (container.clientHeight - this.imageBaseHeight) / 2;
        this.setImageViewTarget(1, targetOffsetX, targetOffsetY);
    }

    // --- Timeline events ---

    onTimelineMouseDown(e) {
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;
        e.preventDefault();
        this.isTimelineDragging = true;
        document.getElementById('timelineThumb').classList.add('dragging');

        const idx = this.getTimelineCameraIndex(e.clientX);
        this.scrubIndex = idx;
        const cam = navCameras[idx];
        this.updateTimelinePosition(cam.id);
        this.showTimelineThumbnail(e.clientX, idx);

        this.setSelectedCameraState(cam.id, true);
        this.smoothPanToCamera(cam);
    }

    onTimelineMouseMove(e) {
        if (!this.isTimelineDragging) return;
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;

        const idx = this.getTimelineCameraIndex(e.clientX);
        if (idx !== this.scrubIndex) {
            this.scrubIndex = idx;
            const cam = navCameras[idx];
            this.updateTimelinePosition(cam.id);

            this.setSelectedCameraState(cam.id, true);
            this.smoothPanToCamera(cam);
        }
        this.showTimelineThumbnail(e.clientX, idx);
    }

    onTimelineMouseUp() {
        if (!this.isTimelineDragging) return;
        const navCameras = this.getNavigationCameras();
        this.isTimelineDragging = false;
        document.getElementById('timelineThumb').classList.remove('dragging');
        this.hideTimelineThumbnail();

        if (this.scrubIndex >= 0 && this.scrubIndex < navCameras.length) {
            this.selectCamera(navCameras[this.scrubIndex].id);
        }
    }

    // --- Timeline touch events ---

    onTimelineTouchStart(e) {
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;
        e.preventDefault();
        this.isTimelineDragging = true;
        document.getElementById('timelineThumb').classList.add('dragging');

        const touch = e.touches[0];
        const idx = this.getTimelineCameraIndex(touch.clientX);
        this.scrubIndex = idx;
        const cam = navCameras[idx];
        this.updateTimelinePosition(cam.id);
        this.showTimelineThumbnail(touch.clientX, idx);

        this.setSelectedCameraState(cam.id, true);
        this.smoothPanToCamera(cam);
    }

    onTimelineTouchMove(e) {
        if (!this.isTimelineDragging) return;
        const navCameras = this.getNavigationCameras();
        if (navCameras.length === 0) return;
        e.preventDefault();
        const touch = e.touches[0];
        const idx = this.getTimelineCameraIndex(touch.clientX);
        if (idx !== this.scrubIndex) {
            this.scrubIndex = idx;
            const cam = navCameras[idx];
            this.updateTimelinePosition(cam.id);
            this.setSelectedCameraState(cam.id, true);
            this.smoothPanToCamera(cam);
        }
        this.showTimelineThumbnail(touch.clientX, idx);
    }

    onTimelineTouchEnd() {
        if (!this.isTimelineDragging) return;
        const navCameras = this.getNavigationCameras();
        this.isTimelineDragging = false;
        document.getElementById('timelineThumb').classList.remove('dragging');
        this.hideTimelineThumbnail();

        if (this.scrubIndex >= 0 && this.scrubIndex < navCameras.length) {
            this.selectCamera(navCameras[this.scrubIndex].id);
        }
    }

    // --- Keyboard ---

    onKeyDown(e) {
        // Only block text inputs, not checkboxes
        if (e.target.tagName === 'TEXTAREA') return;
        if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;

        switch (e.key) {
            case 'ArrowLeft':
            case 'ArrowDown':
                e.preventDefault();
                this.stopPlayback();
                this.clearMapHoverState();
                this.navigateCamera(-1);
                break;

            case 'ArrowRight':
            case 'ArrowUp':
                e.preventDefault();
                this.stopPlayback();
                this.clearMapHoverState();
                this.navigateCamera(1);
                break;

            case ' ':
                e.preventDefault();
                this.togglePlayback();
                break;

            case 'm':
            case 'M':
                this.showPointCloud = !this.showPointCloud;
                document.getElementById('showPointCloud').checked = this.showPointCloud;
                this.render();
                break;

            case 'c':
            case 'C':
                this.showCameras = !this.showCameras;
                document.getElementById('showCameras').checked = this.showCameras;
                if (!this.showCameras) {
                    this.clearMapHoverState();
                }
                this.render();
                break;

            case 'a':
            case 'A':
                if (!this.readOnly) this.toggleAnnotationMode();
                break;

            case 'b':
            case 'B':
                if (!this.readOnly && this.annotationMode) {
                    this.isBoxDrawMode = !this.isBoxDrawMode;
                    this.canvas.style.cursor = this.isBoxDrawMode ? 'crosshair' : 'grab';
                }
                break;

            case 'Escape':
                if (this.companionMode) {
                    this.toggleCompanionMode();
                    const dialog = document.getElementById('companionDialog');
                    if (dialog) dialog.remove();
                    break;
                }
                this.deselectCamera();
                if (!this.readOnly && this.selectedAnnotation !== null) {
                    this.selectedAnnotation = null;
                    this.renderAnnotationBoxes();
                }
                break;

            case 'Delete':
            case 'Backspace':
                if (!this.readOnly && this.annotationMode && this.selectedCamera !== null) {
                    const selCam = this.cameras.find(c => c.id === this.selectedCamera);
                    if (selCam && selCam.isManualCompanion) {
                        e.preventDefault();
                        this.removeCompanionCamera(this.selectedCamera);
                    }
                }
                break;

            case 'x':
            case 'X':
                if (!this.readOnly && this.annotationMode && this.selectedAnnotation !== null) {
                    this.deleteAnnotation(this.selectedAnnotation);
                }
                break;

            case 'q':
            case 'Q':
                if (!this.readOnly && this.annotationMode) {
                    this.applyRotation(-1);
                }
                break;

            case 'e':
            case 'E':
                if (!this.readOnly && this.annotationMode) {
                    this.applyRotation(1);
                }
                break;

            case 's':
            case 'S':
                if (!this.readOnly && this.annotationMode) {
                    e.preventDefault();
                    this.exportAnnotatedData();
                }
                break;

            case 'g':
            case 'G':
                if (!this.readOnly && this.annotationMode) this.toggleCompanionMode();
                break;

            case '?':
                document.getElementById('helpOverlay').classList.toggle('visible');
                break;
        }
    }

    // --- Divider drag ---

    setupDivider() {
        const divider = document.getElementById('divider');
        const mapPanel = document.getElementById('mapPanel');
        const mainContent = document.getElementById('mainContent');
        let isDividerDragging = false;

        const isMobile = () => window.innerWidth < 800;

        divider.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDividerDragging = true;
            divider.classList.add('active');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDividerDragging) return;

            const rect = mainContent.getBoundingClientRect();

            if (isMobile()) {
                const pct = ((e.clientY - rect.top) / rect.height) * 100;
                mapPanel.style.height = Math.max(20, Math.min(80, pct)) + '%';
            } else {
                const pct = ((e.clientX - rect.left) / rect.width) * 100;
                mapPanel.style.width = Math.max(20, Math.min(80, pct)) + '%';
            }

            this.resize();
            this.updateVisibleCameras();
            this.render();
            this.refitImage();
            if (this.selectedCamera !== null) {
                this.updateTimelinePosition(this.selectedCamera);
            }
        });

        document.addEventListener('mouseup', () => {
            isDividerDragging = false;
            divider.classList.remove('active');
        });
    }
}

// ============================================================================
// Initialize
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('glCanvas');
    const compassCanvas = document.getElementById('compassCanvas');
    window.viewer = new StoreLayoutViewer(canvas, compassCanvas, {
        readOnly: window.VIEWER_READ_ONLY === true,
        dataBaseUrl: window.LAYOUT_DATA_BASE_URL || './',
        saveBaseUrl: window.LAYOUT_SAVE_BASE_URL || '',
        labelsYamlUrl: window.LAYOUT_LABELS_YAML_URL || 'labels.yaml',
    });
});
