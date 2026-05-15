/**
 * Interactive Store Layout Map
 *
 * WebGL2 map renderer with split-pane image viewer, compass, timeline scrubber,
 * and dynamic camera density based on zoom level.
 *
 * Forked from point_cloud_editor/web/editor.js (read-only, no editing).
 */

// Map zoom limits (easy to tune)
const MAP_MIN_ZOOM = 0.1;
const MAP_MAX_ZOOM = 25.0;
const MAP_DATA_FILE = 'viewer_map.json.gz';
const LABEL_DATA_FILE = 'viewer_label.json.gz';
const CHINESE_TEXT_REGEX = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CHINESE_TEXT_REGEX_GLOBAL = /[\u3400-\u9fff\uf900-\ufaff]/gu;

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

        // Path configuration (for Store Layout Map integration)
        this.dataBaseUrl = options.dataBaseUrl || './';
        this.saveBaseUrl = options.saveBaseUrl || '';
        this.assetsUrl = options.assetsUrl || (this.saveBaseUrl ? `${this.saveBaseUrl}/assets` : '');
        this.labelsYamlUrl = options.labelsYamlUrl || 'labels.yaml';
        this.businessCategoryYamlUrl = options.businessCategoryYamlUrl || 'business_l1_l2.yaml';

        // Display preferences
        this.englishOnlyStorageKey = 'storeLayout_englishOnly';
        this.englishOnly = false;
        this.englishDisplayCache = new Map();

        // Per-image recognition/taxonomy data (from recognize_task.py)
        this.recogData = {};
        this.showRecogDetails = false;

        // Optional CSV metadata/results matched by image stem
        this.storeAssetMeta = null;
        this.storeAssetBaseUrl = '';
        this.csvFiles = [];
        this.activeCsvFile = null;
        this.csvRowIndex = new Map();
        this.csvLoadState = 'idle';
        this.csvStatusMessage = '';

        // Debug: OpenMVG match pairs
        this.matchPairs = [];
        this.trackPairs = [];
        this.matchAdjacency = new Map(); // cam_id -> Set of connected cam_ids
        this.trackAdjacency = new Map(); // cam_id -> Set of connected cam_ids
        this.showDebugMatches = false;
        this.debugConnectionSource = 'tracks';

        // Annotation mode state — always on
        this.annotationMode = true;
        this.annotations = [];         // [{id, type, x, y, width, height, label, attribute, level, attributes}] in world coords
        this.rotationAngle = 0;        // cumulative rotation in degrees
        this.nextAnnotationId = 1;
        this.selectedAnnotation = null; // id of currently selected annotation box
        this.selectedSplitRegion = null; // { annotationId, regionId } for split-bbox leaf selection
        this.isSplitBoxDrawMode = false;
        this.isDrawingBox = false;
        this.drawStartWorld = null;     // {x, y} world coords of box start
        this.drawCurrentWorld = null;   // {x, y} current mouse world coords
        this.configuredLabels = [];     // loaded from labels.yaml
        this.configuredLabelGroups = {}; // { groupName: [labels] } from labels.yaml
        this.configuredLabelGroupNames = []; // ordered group names
        this.configuredLabelGroupMeta = {};  // { groupName: {type, level, color} } from label_metadata
        this.businessCategoryStores = []; // [{ name, categories, categoryOrder, categoryIndex }] from business_l1_l2.yaml
        this.businessCategoryStoreIndex = new Map(); // normalized storeName -> store entry
        this.categoryColorPalette = [
            '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
            '#FF00FF', '#00FFFF', '#FFA500', '#800080',
            '#008000', '#000080', '#808000', '#008080',
            '#FFC0CB', '#A52A2A', '#808080', '#FFD700'
        ];
        this.categoryColorAssignments = new Map();
        this.pendingBox = null;         // box awaiting label selection
        this.pendingBoxKind = 'bbox';   // 'bbox' or 'split-bbox'
        this.pendingPolygon = null;     // polygon awaiting label selection
        this.isDraggingAnnotation = false;
        this.dragAnnotationId = null;
        this.dragAnnotationOffset = null; // {dx, dy} offset from box origin to grab point
        this.hasUnsavedChanges = false;
        this.draggingSplitDivider = null;

        // Polygon draw mode state
        this.isDrawingPolygon = false;
        this.polygonCurrentVertices = []; // [{x,y}] world coords being drawn
        this.polygonSnapThreshold = 15;   // pixels to snap-to-start
        this.polygonMouseWorld = null;    // current mouse position while drawing

        // History (undo/redo)
        this.historyStack = [];
        this.historyIndex = -1;
        this.historyMaxSize = 50;

        // Layer visibility per level (1-5)
        this.layerVisibility = {1: true, 2: true, 3: true, 4: true, 5: true};

        // Companion mode state
        this.companionMode = false;
        this.manualCompanions = [];     // manually added companion cameras
        this.nextManualCompanionId = 10000; // start IDs high to avoid collision

        // Calibration / scale bar state
        this.calibrationMode = false;
        this.calibrationPoints = [];    // [{x, y}] world coords, max 2
        this.baseRatio = null;          // real distance per world unit
        this.calibrationUnit = 'm';

        // Loaded data file names (for save-back / split map-label storage)
        this.loadedDataFileName = null;
        this.loadedMapFileName = null;
        this.loadedLabelFileName = null;
        this.mapDataNeedsInitialSave = false;
        this.hasUnsavedMapChanges = false;

        // Performance: flat Float32Array for GPU upload (avoids flat() on every upload)
        this.pointCloudBuffer = new Float32Array(0);
        this.pointCount = 0;

        // Performance: cached bounding box of all data — invalidated only on load/rotation
        this._dataBoundsCache = null;

        // Performance: O(1) camera lookup by id
        this._cameraMap = new Map();

        // Performance: rAF throttle for hover detection
        this._pendingMouseMoveEvent = null;
        this._rafMouseMoveScheduled = false;

        // Performance: track overlay count to rebuild static color buffers only when needed
        this._overlayBufferCount = 0;
        this._overlayColorSignature = '';

        // WebGL resources
        this.pointProgram = null;
        this.cameraProgram = null;
        this.lineProgram = null;
        this.locations = null; // cached uniform/attrib locations — populated in setupWebGL()
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
        this.overlayHaloColorBuffer = null;
        this.overlayCoreColorBuffer = null;

        // Point-cloud PNG cache layer
        this.pcCanvas = document.getElementById('pcCanvas');
        this.pcCtx = this.pcCanvas ? this.pcCanvas.getContext('2d') : null;
        this.pcCacheValid = false;
        this.pcRefZoom = 1;
        this.pcRefPanX = 0;
        this.pcRefPanY = 0;
        this._pcCaptureDebounceTimer = null;

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
        this.loadEnglishOnlyPreference();
        this.setupWebGL();
        this.setupEventListeners();
        this.loadLabelsConfig();
        this.loadBusinessCategoryConfig();
        this.loadStoreCsvData();
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
        // Separate static color buffers for halo / core overlay markers (uploaded once, reused every frame)
        this.overlayHaloColorBuffer = gl.createBuffer();
        this.overlayCoreColorBuffer = gl.createBuffer();
        this.matchLineBuffer = gl.createBuffer();
        // Pre-allocated buffer for calibration overlay (avoids create/delete on every render call)
        this.calibrationBuffer = gl.createBuffer();

        // Cache all shader uniform/attribute locations once — avoids 14+ GL state queries per frame.
        this.locations = {
            point: {
                viewMatrix: gl.getUniformLocation(this.pointProgram, 'u_viewMatrix'),
                pointSize:  gl.getUniformLocation(this.pointProgram, 'u_pointSize'),
                color:      gl.getUniformLocation(this.pointProgram, 'u_color'),
                position:   gl.getAttribLocation(this.pointProgram,  'a_position'),
            },
            camera: {
                viewMatrix: gl.getUniformLocation(this.cameraProgram, 'u_viewMatrix'),
                pointSize:  gl.getUniformLocation(this.cameraProgram, 'u_pointSize'),
                position:   gl.getAttribLocation(this.cameraProgram,  'a_position'),
                color:      gl.getAttribLocation(this.cameraProgram,  'a_color'),
            },
            line: {
                viewMatrix: gl.getUniformLocation(this.lineProgram, 'u_viewMatrix'),
                color:      gl.getUniformLocation(this.lineProgram, 'u_color'),
                position:   gl.getAttribLocation(this.lineProgram,  'a_position'),
            },
        };
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
        const resp = await fetch(url, { cache: 'no-cache' });
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
            try {
                const mapData = await this.fetchGzippedJson(base + MAP_DATA_FILE);
                let labelData = {};
                try {
                    labelData = await this.fetchGzippedJson(base + LABEL_DATA_FILE);
                } catch (labelError) {
                    console.warn('No separate label data found; loading map data only:', labelError);
                }

                this.loadedMapFileName = MAP_DATA_FILE;
                this.loadedLabelFileName = LABEL_DATA_FILE;
                this.loadedDataFileName = LABEL_DATA_FILE;
                this.mapDataNeedsInitialSave = false;
                this.loadData(this.mergeMapAndLabelData(mapData, labelData));
                this.handleUrlParams();
                return;
            } catch (mapError) {
                // New split storage is not available yet; fall back to legacy single-file data below.
            }

            // Find the newest viewer_*.json.gz file by Last-Modified time
            let dataUrl = base + LABEL_DATA_FILE;
            try {
                const listResp = await fetch(base);
                if (listResp.ok) {
                    const text = await listResp.text();
                    const matches = text.match(/viewer_.*?\.json\.gz/g);
                    if (matches && matches.length > 0) {
                        const taskFiles = [...new Set(matches)].filter(f => f !== LABEL_DATA_FILE && f !== MAP_DATA_FILE);

                        if (taskFiles.length > 0) {
                            taskFiles.sort().reverse();
                            dataUrl = base + taskFiles[0];
                        } else {
                            dataUrl = base + LABEL_DATA_FILE; // 只有没找到任务文件时才用默认的
                        }
                    }
                }
            } catch (_) { /* listing not available, use default */ }

            this.loadedDataFileName = dataUrl.split('/').pop();
            const data = await this.fetchGzippedJson(dataUrl);
            this.loadedMapFileName = null;
            this.loadedLabelFileName = LABEL_DATA_FILE;
            this.mapDataNeedsInitialSave = this.hasEmbeddedMapData(data);
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

    hasEmbeddedMapData(data) {
        return Boolean(
            data &&
            typeof data === 'object' &&
            (Array.isArray(data.pointCloud) || Array.isArray(data.cameras) || data.metadata)
        );
    }

    mergeMapAndLabelData(mapData = {}, labelData = {}) {
        const merged = { ...(mapData || {}) };
        const label = labelData || {};

        for (const [key, value] of Object.entries(label)) {
            if (['pointCloud', 'cameras', 'mapAnnotations', 'matchPairs', 'trackPairs', 'recogData'].includes(key)) {
                continue;
            }
            if (key === 'metadata') {
                merged.metadata = { ...(mapData.metadata || {}), ...(value || {}) };
                continue;
            }
            if (key === 'rotationApplied' && typeof mapData.rotationApplied === 'number') {
                continue;
            }
            merged[key] = value;
        }

        if (!Array.isArray(merged.annotations)) {
            merged.annotations = [];
        }
        return merged;
    }

    getImageStem(name) {
        if (!name) return '';
        const fileName = String(name).split('/').pop().split('?')[0].split('#')[0];
        return fileName.replace(/\.[^.]+$/, '');
    }

    loadEnglishOnlyPreference() {
        try {
            this.englishOnly = localStorage.getItem(this.englishOnlyStorageKey) === 'true';
        } catch (_) {
            this.englishOnly = false;
        }
        this.syncEnglishOnlyToggle();
    }

    persistEnglishOnlyPreference() {
        try {
            localStorage.setItem(this.englishOnlyStorageKey, this.englishOnly ? 'true' : 'false');
        } catch (_) { /* ignore */ }
    }

    syncEnglishOnlyToggle() {
        const toggle = document.getElementById('englishOnlyToggle');
        if (toggle) toggle.checked = this.englishOnly;
    }

    setEnglishOnly(nextValue) {
        const enabled = Boolean(nextValue);
        const changed = this.englishOnly !== enabled;

        this.englishOnly = enabled;
        this.persistEnglishOnlyPreference();
        this.syncEnglishOnlyToggle();

        if (!changed) return;

        this.englishDisplayCache.clear();
        this.refreshEnglishOnlyDisplay();
    }

    refreshEnglishOnlyDisplay() {
        const picker = document.getElementById('labelPicker');
        const pickerAnchor = picker
            ? {
                x: picker.getBoundingClientRect().left,
                y: picker.getBoundingClientRect().top,
            }
            : null;

        this.render();
        this.renderMapLegend();

        if (pickerAnchor && (this.pendingBox || this.pendingPolygon)) {
            this.showLabelPicker(pickerAnchor.x, pickerAnchor.y);
        }
    }

    getDisplayText(value) {
        if (value === null || value === undefined) return '';

        const rawText = String(value);
        if (!this.englishOnly) return rawText;

        const trimmed = rawText.trim();
        if (!trimmed) return '';

        const cached = this.englishDisplayCache.get(trimmed);
        if (cached !== undefined) return cached;

        let result = trimmed.normalize('NFKC');

        if (!CHINESE_TEXT_REGEX.test(result)) {
            this.englishDisplayCache.set(trimmed, result);
            return result;
        }

        result = result
            .replace(/\s*<[^<>]*[\u3400-\u9fff\uf900-\ufaff][^<>]*>\s*/gu, ' ')
            .replace(/\s*\([^()]*[\u3400-\u9fff\uf900-\ufaff][^()]*\)\s*/gu, ' ')
            .replace(/\s*（[^（）]*[\u3400-\u9fff\uf900-\ufaff][^（）]*）\s*/gu, ' ')
            .replace(/\s*\[[^\[\]]*[\u3400-\u9fff\uf900-\ufaff][^\[\]]*\]\s*/gu, ' ')
            .replace(/\s*【[^【】]*[\u3400-\u9fff\uf900-\ufaff][^【】]*】\s*/gu, ' ')
            .replace(/\s*「[^「」]*[\u3400-\u9fff\uf900-\ufaff][^「」]*」\s*/gu, ' ')
            .replace(/\s*『[^『』]*[\u3400-\u9fff\uf900-\ufaff][^『』]*』\s*/gu, ' ')
            .replace(CHINESE_TEXT_REGEX_GLOBAL, ' ')
            .replace(/[，。；：、！？]/gu, ' ')
            .replace(/<\s*>|\(\s*\)|（\s*）|\[\s*\]|【\s*】|「\s*」|『\s*』/gu, ' ')
            .replace(/\s*([·/,:;|])\s*/g, ' $1 ')
            .replace(/(?:^|\s)[·/,:;|](?=\s|$)/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[·/,:;|\s]+|[·/,:;|\s]+$/g, '')
            .trim();

        this.englishDisplayCache.set(trimmed, result);
        return result;
    }

    getDisplayTextList(value) {
        const values = Array.isArray(value) ? value : [value];
        return values
            .map(item => this.getDisplayText(item).trim())
            .filter(Boolean);
    }

    normalizeSearchText(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .normalize('NFKC')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    getOptionSearchText(value) {
        const raw = this.normalizeSearchText(value);
        const display = this.normalizeSearchText(this.getDisplayText(value));
        return [...new Set([raw, display].filter(Boolean))].join(' ');
    }

    filterOptionsBySearch(options, query, preservedValues = []) {
        const values = Array.isArray(options) ? [...options] : [];
        for (const preserved of preservedValues || []) {
            if (preserved && !values.includes(preserved)) {
                values.unshift(preserved);
            }
        }

        const normalizedQuery = this.normalizeSearchText(query);
        if (!normalizedQuery) return values;

        const terms = normalizedQuery.split(' ').filter(Boolean);
        return values.filter((opt) => {
            const haystack = this.getOptionSearchText(opt);
            return terms.every(term => haystack.includes(term));
        });
    }

    setCsvState(state, message = '') {
        this.csvLoadState = state;
        this.csvStatusMessage = message;
    }

    async loadStoreCsvData() {
        if (!this.assetsUrl) {
            this.setCsvState('no-csv');
            this.updateImageCsvBar(this.selectedCamera !== null ? this.getCameraById(this.selectedCamera) : null);
            return;
        }

        this.setCsvState('loading', 'Loading CSV information…');
        this.updateImageCsvBar(this.selectedCamera !== null ? this.getCameraById(this.selectedCamera) : null);

        try {
            const resp = await fetch(this.assetsUrl, { cache: 'no-cache' });
            if (!resp.ok) {
                throw new Error(`Failed to load assets metadata: ${resp.status}`);
            }

            const payload = await resp.json();
            this.storeAssetMeta = payload;
            this.storeAssetBaseUrl = payload.asset_base_url || `${this.assetsUrl.replace(/\/$/, '')}/`;
            this.csvFiles = Array.isArray(payload.csv_files) ? payload.csv_files : [];

            if (this.csvFiles.length === 0) {
                this.activeCsvFile = null;
                this.csvRowIndex = new Map();
                this.setCsvState('no-csv');
            } else if (this.csvFiles.length > 1) {
                this.activeCsvFile = null;
                this.csvRowIndex = new Map();
                this.setCsvState('multiple', `Detected multiple CSV files (${this.csvFiles.join(', ')}), not automatically selected.`);
            } else {
                this.activeCsvFile = this.csvFiles[0];
                await this.loadCsvFile(this.activeCsvFile);
            }
        } catch (error) {
            console.warn('Failed to load store CSV assets:', error);
            this.activeCsvFile = null;
            this.csvRowIndex = new Map();
            this.setCsvState('error', 'Failed to load ML inference results, please try again later.');
        }

        this.updateImageCsvBar(this.selectedCamera !== null ? this.getCameraById(this.selectedCamera) : null);
    }

    async loadCsvFile(fileName) {
        if (!fileName) {
            this.csvRowIndex = new Map();
            this.setCsvState('no-csv');
            return;
        }

        this.setCsvState('loading', `Loading ${fileName}…`);
        this.updateImageCsvBar(this.selectedCamera !== null ? this.getCameraById(this.selectedCamera) : null);

        const csvBaseUrl = this.storeAssetBaseUrl || `${this.assetsUrl.replace(/\/$/, '')}/`;
        const csvUrl = `${csvBaseUrl}${encodeURIComponent(fileName)}`;
        const resp = await fetch(csvUrl, { cache: 'no-cache' });
        if (!resp.ok) {
            throw new Error(`Failed to load CSV: ${resp.status}`);
        }

        const text = await resp.text();
        const rows = this.parseCsv(text);
        this.csvRowIndex = this.indexCsvRows(rows);
        this.setCsvState('ready');
    }

    parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;

        const pushField = () => {
            row.push(field);
            field = '';
        };

        const pushRow = () => {
            rows.push(row);
            row = [];
        };

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (inQuotes) {
                if (char === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += char;
                }
                continue;
            }

            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                pushField();
            } else if (char === '\n') {
                pushField();
                pushRow();
            } else if (char !== '\r') {
                field += char;
            }
        }

        if (field.length > 0 || row.length > 0) {
            pushField();
            pushRow();
        }

        if (!rows.length) return [];

        const headers = rows[0].map((header, index) => {
            const cleaned = (header || '').trim();
            return index === 0 ? cleaned.replace(/^\uFEFF/, '') : cleaned;
        });

        return rows.slice(1)
            .filter(values => values.some(value => String(value || '').trim().length > 0))
            .map(values => {
                const result = {};
                headers.forEach((header, index) => {
                    if (!header) return;
                    result[header] = (values[index] || '').trim();
                });
                return result;
            });
    }

    indexCsvRows(rows) {
        const index = new Map();
        for (const row of rows) {
            const imageName = row.image_name || row.image || row.filename || '';
            const stem = this.getImageStem(imageName);
            if (!stem || index.has(stem)) continue;
            index.set(stem, row);
        }
        return index;
    }

    getCsvRowForImage(imageName) {
        const stem = this.getImageStem(imageName);
        if (!stem) return null;
        return this.csvRowIndex.get(stem) || null;
    }

    resetImageCsvBar() {
        const bar = document.getElementById('imageCsvBar');
        const status = document.getElementById('imageCsvStatus');
        const cards = document.getElementById('imageCsvCards');
        if (!bar || !status || !cards) return;

        bar.classList.remove('visible');
        status.className = 'image-csv-status';
        status.textContent = '';
        cards.classList.remove('visible');

        const fields = [
            'imageCsvLeftCategory',
            'imageCsvLeftSubCategory',
            'imageCsvRightCategory',
            'imageCsvRightSubCategory',
        ];
        for (const fieldId of fields) {
            const el = document.getElementById(fieldId);
            if (el) el.textContent = '-';
        }
    }

    showImageCsvStatus(message, variant = 'placeholder') {
        const bar = document.getElementById('imageCsvBar');
        const status = document.getElementById('imageCsvStatus');
        const cards = document.getElementById('imageCsvCards');
        if (!bar || !status || !cards) return;

        bar.classList.add('visible');
        cards.classList.remove('visible');
        status.textContent = message;
        status.className = `image-csv-status visible image-csv-status--${variant}`;
    }

    showImageCsvCards(row) {
        const bar = document.getElementById('imageCsvBar');
        const status = document.getElementById('imageCsvStatus');
        const cards = document.getElementById('imageCsvCards');
        if (!bar || !status || !cards) return;

        const assignText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value || '-';
        };

        assignText('imageCsvLeftCategory', row.left_category);
        assignText('imageCsvLeftSubCategory', row.left_sub_category);
        assignText('imageCsvRightCategory', row.right_category);
        assignText('imageCsvRightSubCategory', row.right_sub_category);

        bar.classList.add('visible');
        status.className = 'image-csv-status';
        status.textContent = '';
        cards.classList.add('visible');
    }

    updateImageCsvBar(cam) {
        this.resetImageCsvBar();
        if (!cam || !cam.imageName) return;

        if (this.csvLoadState === 'no-csv') {
            return;
        }

        if (this.csvLoadState === 'loading') {
            this.showImageCsvStatus(this.csvStatusMessage || 'loading…', 'placeholder');
            return;
        }

        if (this.csvLoadState === 'multiple') {
            this.showImageCsvStatus(this.csvStatusMessage || 'Detected multiple CSV files, not automatically selected.', 'warning');
            return;
        }

        if (this.csvLoadState === 'error') {
            this.showImageCsvStatus(this.csvStatusMessage || 'Failed to load ML inference results, please try again later.', 'error');
            return;
        }

        const row = this.getCsvRowForImage(cam.imageName);
        if (!row) {
            this.showImageCsvStatus('No CSV results available', 'placeholder');
            return;
        }

        this.showImageCsvCards(row);
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

        // Performance: build O(1) camera ID index
        this._cameraMap = new Map(this.cameras.map(c => [c.id, c]));

        // Performance: convert point cloud to flat Float32Array once — avoids .flat() on every GPU upload
        const rawCloud = this.pointCloud;
        this.pointCount = rawCloud.length;
        if (this.pointCount > 0) {
            this.pointCloudBuffer = new Float32Array(this.pointCount * 2);
            for (let i = 0; i < this.pointCount; i++) {
                this.pointCloudBuffer[i * 2]     = rawCloud[i][0];
                this.pointCloudBuffer[i * 2 + 1] = rawCloud[i][1];
            }
        } else {
            this.pointCloudBuffer = new Float32Array(0);
        }

        // Load saved annotations and rotation state
        if (Array.isArray(data.annotations)) {
            this.annotations = data.annotations.map(a => {
                // Backward-compat: ensure type and level fields exist
                const ann = {
                    ...a,
                    attributes: a && typeof a.attributes === 'object' && a.attributes !== null
                        ? JSON.parse(JSON.stringify(a.attributes))
                        : {}
                };
                if (!ann.type) ann.type = 'bbox';
                if (ann.level == null) {
                    ann.level = this.getLevelForGroup(ann.attribute);
                }
                if (ann.attribute === 'aisle') {
                    ann.attributes.side = this.normalizeAisleDirection(ann.attributes.side);
                }
                if (ann.type === 'split-bbox') {
                    ann.attributes.splitTree = this.normalizeSplitTree(ann.attributes.splitTree);
                }
                if (ann.type === 'bbox' && ann.angle == null) ann.angle = 0;
                if (ann.type === 'split-bbox' && ann.angle == null) ann.angle = 0;
                return ann;
            });
            this.nextAnnotationId = this.annotations.reduce((max, a) => Math.max(max, (a.id || 0) + 1), 1);
        }
        if (typeof data.rotationApplied === 'number') {
            this.rotationAngle = data.rotationApplied;
        }

        // Initialize undo/redo history from loaded state
        this.historyStack = [JSON.parse(JSON.stringify(this.annotations))];
        this.historyIndex = 0;

        // Restore manual companion tracking from loaded cameras
        this.manualCompanions = this.cameras.filter(c => c.isManualCompanion);
        if (this.manualCompanions.length > 0) {
            this.nextManualCompanionId = this.manualCompanions.reduce(
                (max, c) => Math.max(max, (c.id || 0) + 1), this.nextManualCompanionId
            );
        }

        this.hasUnsavedChanges = false;
        this.hasUnsavedMapChanges = false;
        this.syncRotationSlider();

        const storeName = this.metadata.storeName ? String(this.metadata.storeName).trim() : '';
        document.title = storeName ? `${storeName} - Store Layout Map` : 'Store Layout Map';

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
        this._computeAndCacheBounds(); // pre-compute after load so all interaction paths use cache
        this.updateVisibleCameras();
        this.hasOverlayCameras = this.cameras.some(c => c.isOverlay);
        this.updateOverlayPulseAnimationState();
        this.fitView();
        // Invalidate any stale cache before first render, then capture fresh
        this.pcCacheValid = false;
        this.render();
        this.capturePointCloudCache();
        this.render(); // re-render cameras/overlays on top of newly cached pcCanvas
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
        // skipDom=true: annotation DOM elements don't change during the idle pulse loop,
        // so skip the expensive renderMapAnnotations() and renderAnnotationBoxes() rebuilds.
        this.render(true);
        this.overlayPulseRaf = requestAnimationFrame(() => this.animateOverlayPulse());
    }

    uploadPointCloud() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.pointCloudBuffer, gl.STATIC_DRAW);
    }

    // Compute and cache the world-space bounding box of cameras + point cloud.
    // Must be called after load and after any rotation that modifies positions.
    _computeAndCacheBounds() {
        const cameras = this.cameras;
        const buf = this.pointCloudBuffer;
        if (cameras.length === 0 && buf.length === 0) {
            this._dataBoundsCache = null;
            return null;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < cameras.length; i++) {
            const x = cameras[i].position[0], y = cameras[i].position[1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        for (let i = 0; i < buf.length; i += 2) {
            const x = buf[i], y = buf[i + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        this._dataBoundsCache = { minX, minY, maxX, maxY };
        return this._dataBoundsCache;
    }

    getCameraById(cameraId) {
        return this._cameraMap.get(cameraId) ?? null;
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

    getCameraPointColor(cam) {
        if (this.hoveredCamera === cam.id) {
            return [0.965, 0.831, 0.278, 1.0]; // Yellow - hovered
        }
        if (this.selectedCamera === cam.id && !this.isAnimatingSelectedIndicator) {
            return [0.965, 0.831, 0.278, 1.0]; // Yellow - selected
        }
        if (cam.isManualCompanion) {
            return [0.604, 0.804, 0.196, 1.0]; // Yellow-green - manual companion
        }
        if (cam.isOverlay) {
            return [0.98, 0.45, 0.18, 1.0]; // Orange - special overlay point
        }
        return [0.086, 0.239, 0.545, 1.0]; // Dark blue - normal
    }

    getOverlayMarkerColors(cam) {
        if (cam.isManualCompanion) {
            return {
                halo: [0.78, 0.92, 0.34, 0.35],
                core: [0.604, 0.804, 0.196, 1.0],
            };
        }
        return {
            halo: [1.0, 0.44, 0.12, 0.35],
            core: [0.98, 0.45, 0.18, 1.0],
        };
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
        const stem = this.getImageStem(cam.imageName);
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
            const sel = this._cameraMap.get(this.selectedCamera);
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
            const hov = this._cameraMap.get(this.hoveredCamera);
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

        // Draw order matters in WebGL point rendering. Keep highlighted cameras last
        // so they always appear on top of non-highlighted cameras.
        const camsDrawOrder = [...cams].sort((a, b) => {
            const rank = (cam) => {
                if (this.hoveredCamera !== null && cam.id === this.hoveredCamera) return 2;
                if (this.selectedCamera !== null && cam.id === this.selectedCamera) return 1;
                return 0;
            };
            return rank(a) - rank(b);
        });

        // Positions
        const positions = new Float32Array(camsDrawOrder.flatMap(c => c.position));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

        const colors = new Float32Array(camsDrawOrder.flatMap(c => this.getCameraPointColor(c)));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);

        // Overlay marker positions for animated pulse rendering.
        this.overlayVisibleCameras = camsDrawOrder.filter(c => c.isOverlay);
        const overlayCount = this.overlayVisibleCameras.length;
        if (overlayCount > 0) {
            const overlayPositions = new Float32Array(
                this.overlayVisibleCameras.flatMap(c => c.position)
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCameraBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, overlayPositions, gl.DYNAMIC_DRAW);

            const overlayColorSignature = this.overlayVisibleCameras
                .map(c => `${c.id}:${c.isManualCompanion ? 'manual' : (c.overlayKind || 'overlay')}`)
                .join('|');

            // Rebuild static halo/core color buffers only when overlay membership or color kind changes.
            if (overlayCount !== this._overlayBufferCount || overlayColorSignature !== this._overlayColorSignature) {
                this._overlayBufferCount = overlayCount;
                this._overlayColorSignature = overlayColorSignature;
                const haloData = new Float32Array(overlayCount * 4);
                const coreData = new Float32Array(overlayCount * 4);
                for (let i = 0; i < overlayCount; i++) {
                    const overlayColors = this.getOverlayMarkerColors(this.overlayVisibleCameras[i]);
                    haloData.set(overlayColors.halo, i * 4);
                    coreData.set(overlayColors.core, i * 4);
                }
                gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayHaloColorBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, haloData, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCoreColorBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, coreData, gl.STATIC_DRAW);
            }
        } else {
            this._overlayBufferCount = 0;
            this._overlayColorSignature = '';
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
        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.0, 0.75, 0.35, 0.7);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.matchLineBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.matchLineVertexCount);
    }

    // ========================================================================
    // View Controls
    // ========================================================================

    computeFitViewState() {
        const bounds = this._dataBoundsCache || this._computeAndCacheBounds();
        if (!bounds) return null;

        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;

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
        return this._dataBoundsCache || this._computeAndCacheBounds();
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
        const bounds = this._dataBoundsCache;
        if (!bounds || this.canvas.width <= 0 || this.canvas.height <= 0) return true;

        // Test the four corners of the bounding box — O(1) instead of O(N) over all points.
        const scaleX = zoom * 2 / this.canvas.width;
        const scaleY = -zoom * 2 / this.canvas.height;
        const epsilon = 1e-6;

        for (const x of [bounds.minX, bounds.maxX]) {
            for (const y of [bounds.minY, bounds.maxY]) {
                const ndcX = (x + panX) * scaleX;
                const ndcY = (y + panY) * scaleY;
                if (ndcX < -1 - epsilon || ndcX > 1 + epsilon || ndcY < -1 - epsilon || ndcY > 1 + epsilon) {
                    return false;
                }
            }
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
        // updateMatchLines is only needed when the selected camera changes, not on every view change.
        // It is called from selectCamera() and deselectCamera() instead.
        this.updateScaleBar();
        // Apply CSS transform to pcCanvas so it tracks pan/zoom without a WebGL redraw
        this.updatePointCloudTransform();
        // Note: renderAnnotationBoxes() is intentionally NOT called here.
        // All callers of updateViewMatrix() follow up with render(), which calls it.
        // Calling it here too would rebuild annotation DOM twice per frame.
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
        // Sync pcCanvas physical size to match glCanvas
        if (this.pcCanvas) {
            this.pcCanvas.width = this.canvas.width;
            this.pcCanvas.height = this.canvas.height;
            this.pcCanvas.style.width = this.canvas.style.width;
            this.pcCanvas.style.height = this.canvas.style.height;
        }
        // Canvas size changed — cached image no longer maps correctly
        this.pcCacheValid = false;
        this.updateViewMatrix();
    }

    // -----------------------------------------------------------------------
    // Point-cloud PNG cache helpers
    // -----------------------------------------------------------------------

    /**
     * Render ONLY the point cloud into the offscreen WebGL canvas, copy the
     * result as a static bitmap into pcCanvas, then record the reference
     * view state.  After this call pcCacheValid = true and render() will
     * skip WebGL point-cloud draw calls.
     */
    capturePointCloudCache() {
        if (!this.pcCanvas || !this.pcCtx || !this.showPointCloud || this.pointCount === 0) {
            this.pcCacheValid = false;
            if (this.pcCanvas) this.pcCanvas.style.opacity = '0';
            return;
        }
        const gl = this.gl;
        // Render point cloud on a transparent background
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.renderPointCloud();

        // Blit WebGL canvas → 2D pcCanvas
        this.pcCtx.clearRect(0, 0, this.pcCanvas.width, this.pcCanvas.height);
        this.pcCtx.drawImage(this.canvas, 0, 0);

        // Store reference view state
        this.pcRefZoom = this.zoom;
        this.pcRefPanX = this.panX;
        this.pcRefPanY = this.panY;
        this.pcCacheValid = true;

        // Reset pcCanvas transform (it is now pixel-perfect)
        this.pcCanvas.style.transform = '';
        this.pcCanvas.style.opacity = '1';
    }

    /**
     * Apply a CSS transform to pcCanvas so it visually tracks the current
     * view without a WebGL redraw.
     */
    updatePointCloudTransform() {
        if (!this.pcCanvas || !this.pcCacheValid) {
            if (this.pcCanvas) this.pcCanvas.style.opacity = '0';
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const s = this.zoom / this.pcRefZoom;
        // pan delta in CSS pixels (physical / dpr)
        // Both X and Y follow the same direction as worldToScreen:
        //   screenY = (wy + panY) * zoom + H/2  => positive panY shifts content down
        const dtx = (this.panX - this.pcRefPanX) * this.zoom / dpr;
        const dty = (this.panY - this.pcRefPanY) * this.zoom / dpr;
        this.pcCanvas.style.transform = `translate(${dtx}px, ${dty}px) scale(${s})`;
        this.pcCanvas.style.opacity = '1';
    }

    // -----------------------------------------------------------------------

    render(skipDom = false) {
        const gl = this.gl;

        // Background is provided by #mapPanel CSS; canvas is transparent
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (this.showPointCloud && this.pointCount > 0 && !this.pcCacheValid) {
            // Cache not ready yet — draw directly (first frame / after invalidation)
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

        // DOM overlay rebuilds are expensive; skip during animation loops where
        // annotation data and view have not changed (e.g. the overlay pulse loop).
        if (!skipDom) {
            this.renderMapAnnotations();
            this.renderAnnotationBoxes();
        }

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

            const rawLabel = typeof annotation.label === 'string' ? annotation.label.trim() : '';
            const label = this.getDisplayText(rawLabel).trim();
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
            const categoryLabel = this.getDisplayText(category ? category[0].toUpperCase() + category.slice(1) : 'Tag') || 'Tag';
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
                    const displayName = this.getDisplayText(cat[0].toUpperCase() + cat.slice(1)) || (cat[0].toUpperCase() + cat.slice(1));
                    entries.set(key, { color, label: displayName });
                }
            }
        }

        // Collect from annotation boxes (category/location labels)
        for (const box of this.annotations) {
            const label = typeof box.label === 'string' ? box.label.trim() : '';
            const attribute = typeof box.attribute === 'string' ? box.attribute.trim() : '';
            if (!label || !attribute) continue;
            const displayLabel = this.getDisplayText(label).trim();
            if (!displayLabel) continue;

            const key = `box:${attribute}:${this.normalizeLabelKey(displayLabel) || label}`;
            if (!entries.has(key)) {
                const theme = this.getLabelTheme(label, attribute);
                if (theme && theme.accentColor) {
                    entries.set(key, { color: theme.accentColor, label: displayLabel });
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
        const locs = this.locations.point;
        gl.useProgram(this.pointProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform1f(locs.pointSize, this.pointSize * window.devicePixelRatio);
        gl.uniform4f(locs.color, 0.22, 0.22, 0.22, 0.85);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }

    renderPath() {
        const gl = this.gl;
        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.40, 0.40, 0.40, 0.72);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.pathVertexCount);
    }

    renderFOVWedge() {
        const gl = this.gl;
        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.0, 0.0, 0.0, 0.52);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.fovBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.fovVertexCount);
    }

    renderDirections() {
        const gl = this.gl;
        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.8, 0.1, 0.1, 0.95);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.directionBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.directionVertexCount);
    }

    renderCameras() {
        const gl = this.gl;
        const locs = this.locations.camera;
        gl.useProgram(this.cameraProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform1f(locs.pointSize, 12 * window.devicePixelRatio);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.cameraColorBuffer);
        gl.enableVertexAttribArray(locs.color);
        gl.vertexAttribPointer(locs.color, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, this.visibleCameras.length);
    }

    renderOverlayMarkers() {
        const overlayCount = this.overlayVisibleCameras.length;
        if (overlayCount === 0) return;

        const gl = this.gl;
        const locs = this.locations.camera;
        gl.useProgram(this.cameraProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCameraBuffer);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.0025);
        const haloSize = (18 + 10 * pulse) * window.devicePixelRatio;
        const coreSize = 10 * window.devicePixelRatio;

        // Halo — uses pre-allocated static color buffer (no per-frame allocation or upload)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayHaloColorBuffer);
        gl.enableVertexAttribArray(locs.color);
        gl.vertexAttribPointer(locs.color, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(locs.pointSize, haloSize);
        gl.drawArrays(gl.POINTS, 0, overlayCount);

        // Core
        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCoreColorBuffer);
        gl.enableVertexAttribArray(locs.color);
        gl.vertexAttribPointer(locs.color, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1f(locs.pointSize, coreSize);
        gl.drawArrays(gl.POINTS, 0, overlayCount);
    }

    renderSelectedCameraOverlay() {
        if (this.selectedCamera === null || !this.selectedIndicatorPose) return;

        const gl = this.gl;
        const locs = this.locations.camera;
        gl.useProgram(this.cameraProgram);

        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform1f(locs.pointSize, 14.4 * window.devicePixelRatio);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedCameraBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([this.selectedIndicatorPose.x, this.selectedIndicatorPose.y]),
            gl.DYNAMIC_DRAW
        );
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);

        const overlayColor = [0.965, 0.831, 0.278, 1.0];
        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedCameraColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(overlayColor), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locs.color);
        gl.vertexAttribPointer(locs.color, 4, gl.FLOAT, false, 0, 0);

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
        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);
        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.8, 0.1, 0.1, 0.95);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedDirectionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);
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
        const locs = this.locations.line;
        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.0, 0.0, 0.0, 0.52);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.selectedFovBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);
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

            // Show/hide delete companion button for any companion photo
            const delBtn = document.getElementById('deleteCompanionBtn');
            if (delBtn) delBtn.style.display = (cam.overlayKind === 'companionPhoto') ? '' : 'none';

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
            this.updateImageCsvBar(cam);

            // Update timeline position
            this.updateTimelinePosition(id);

            // Update URL without reloading
            const url = new URL(window.location);
            url.searchParams.set('cam', id);
            window.history.replaceState({}, '', url);

            // Smoothly pan map to keep selected camera visible
            this.smoothPanToCamera(cam);
        }

        this.updateMatchLines(); // selectedCamera changed → update debug match lines
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
        this.updateImageCsvBar(null);
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
        this.updateMatchLines(); // selectedCamera changed → update debug match lines
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
            // Sync visible cameras once at the end of the pan (zoom didn't change, set is same)
            this.updateVisibleCameras();
            this.render();
            this.isAnimatingPan = false;
            // Refresh point cloud cache now that pan has settled
            this.capturePointCloudCache();
            this.render();
            return;
        }

        const lerpFactor = 0.15;
        this.panX += dx * lerpFactor;
        this.panY += dy * lerpFactor;
        this.updateViewMatrix();
        // Skip updateVisibleCameras during pan frames: zoom unchanged → visible set unchanged
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
            // Cancel any in-progress annotation drawing when entering calibration
            if (this.isDrawingPolygon) this.cancelPolygon();
            this.isDrawingBox = false;
            this.isBoxDrawMode = false;
            this.isSplitBoxDrawMode = false;
            this.drawStartWorld = null;
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

        // Reuse pre-allocated buffer (avoids gl.createBuffer/deleteBuffer per frame)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.calibrationBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);

        const locs = this.locations.line;
        gl.useProgram(this.lineProgram);
        gl.enableVertexAttribArray(locs.position);
        gl.vertexAttribPointer(locs.position, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix3fv(locs.viewMatrix, false, this.viewMatrix);
        gl.uniform4f(locs.color, 0.90, 0.25, 0.20, 1.0); // red-ish color

        gl.lineWidth(2.0);
        gl.drawArrays(gl.LINES, 0, verts.length / 2);
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
        // Annotation mode is always on. This method now only cancels any in-progress drawing.
        if (this.isDrawingPolygon) this.cancelPolygon();
        this.isDrawingBox = false;
        this.drawStartWorld = null;
        this.isBoxDrawMode = false;
        this.isSplitBoxDrawMode = false;
        this.canvas.style.cursor = 'grab';
        this.drawCurrentWorld = null;
        this.renderAnnotationBoxes();
        this.updateUndoRedoButtons();
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
            this.isSplitBoxDrawMode = false;
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
        this._cameraMap.set(companion.id, companion);

        this.hasOverlayCameras = true;
        this.updateOverlayPulseAnimationState();
        this.updateVisibleCameras();
        this.hasUnsavedChanges = true;
        this.hasUnsavedMapChanges = true;
        this.render();

        // Select the newly added companion
        this.selectCamera(id);
    }

    removeCompanionCamera(id) {
        const idx = this.cameras.findIndex(c => c.id === id);
        if (idx < 0) return;
        const cam = this.cameras[idx];
        if (cam.overlayKind !== 'companionPhoto') return;
        if (!confirm('Delete this companion photo?')) return;

        this.cameras.splice(idx, 1);
        this.cameraTimestamps.splice(idx, 1);
        this._cameraMap.delete(id);
        this.manualCompanions = this.manualCompanions.filter(c => c.id !== id);

        if (this.selectedCamera === id) this.deselectCamera();
        this.hasOverlayCameras = this.cameras.some(c => c.isOverlay);
        this.updateOverlayPulseAnimationState();
        this.updateVisibleCameras();
        this.hasUnsavedChanges = true;
        this.hasUnsavedMapChanges = true;
        this.render();
    }

    computeDataCenter() {
        const bounds = this._dataBoundsCache || this._computeAndCacheBounds();
        if (!bounds) return { x: 0, y: 0 };
        return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    }

    async loadLabelsConfig() {
        const STORAGE_KEY = 'storeBEV_customLabels';
        try {
            const resp = await fetch(this.labelsYamlUrl);
            if (!resp.ok) return;
            const text = await resp.text();
            const lines = text.split('\n');
            let section = null; // 'labels' | 'label_metadata' | null
            let currentGroup = null;
            let currentMetaGroup = null;
            const groups = {};
            const groupOrder = [];
            const flatLabels = [];
            const groupMeta = {};

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith('#')) continue;
                if (/^labels\s*:/.test(trimmed)) { section = 'labels'; currentGroup = null; continue; }
                if (/^label_metadata\s*:/.test(trimmed)) { section = 'label_metadata'; currentMetaGroup = null; continue; }
                // Top-level non-indented key resets section
                if (!line.startsWith(' ') && !line.startsWith('\t')) { section = null; continue; }

                if (section === 'labels') {
                    // Group header: "  fixture:" (2-4 spaces + word + colon)
                    const groupMatch = line.match(/^[ \t]{2,4}([\w][\w\s-]*):\s*$/);
                    if (groupMatch) {
                        currentGroup = groupMatch[1].trim();
                        if (!groups[currentGroup]) {
                            groups[currentGroup] = [];
                            groupOrder.push(currentGroup);
                        }
                        continue;
                    }
                    // List item
                    const itemMatch = line.match(/^\s*-\s+(.+)$/);
                    if (itemMatch) {
                        const label = itemMatch[1].trim();
                        if (currentGroup) groups[currentGroup].push(label);
                        flatLabels.push(label);
                    }
                } else if (section === 'label_metadata') {
                    // Group header (2 spaces): "  boundary:"
                    const groupMatch = line.match(/^  ([\w][\w\s-]*):\s*$/);
                    if (groupMatch) {
                        currentMetaGroup = groupMatch[1].trim();
                        if (!groupMeta[currentMetaGroup]) groupMeta[currentMetaGroup] = {};
                        continue;
                    }
                    // Key-value pair (4 spaces): "    type: polygon"
                    if (currentMetaGroup) {
                        const kvMatch = line.match(/^ {4,}([\w]+)\s*:\s*'?"?([^'"\n]+)'?"?\s*$/);
                        if (kvMatch) {
                            const key = kvMatch[1].trim();
                            let val = kvMatch[2].trim();
                            if (key === 'level') val = parseInt(val, 10);
                            groupMeta[currentMetaGroup][key] = val;
                        }
                    }
                }
            }

            this.configuredLabelGroups = groups;
            this.configuredLabelGroupNames = groupOrder;
            this.configuredLabelGroupMeta = groupMeta;

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

    async loadBusinessCategoryConfig() {
        try {
            const resp = await fetch(this.businessCategoryYamlUrl);
            if (!resp.ok) return;
            const text = await resp.text();
            const stores = this.parseBusinessCategoryYaml(text);
            this.businessCategoryStores = stores;
            this.businessCategoryStoreIndex = new Map();

            for (const store of stores) {
                const key = this.normalizeLabelKey(store.name);
                if (key && !this.businessCategoryStoreIndex.has(key)) {
                    this.businessCategoryStoreIndex.set(key, store);
                }
            }

            this.renderMapLegend();
            this.updateAttributesPanel();
        } catch (e) { /* business_l1_l2.yaml not available */ }
    }

    parseBusinessCategoryYaml(text) {
        const stores = [];
        let currentStore = null;
        let currentCategory = null;

        const ensureCategoryIndex = (store) => {
            if (!store.categoryIndex) store.categoryIndex = new Map();
            for (const category of store.categoryOrder) {
                const key = this.normalizeLabelKey(category);
                if (key && !store.categoryIndex.has(key)) {
                    store.categoryIndex.set(key, category);
                }
            }
        };

        for (const rawLine of text.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const indent = (line.match(/^\s*/) || [''])[0].length;
            const keyMatch = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*$/);
            const itemMatch = trimmed.match(/^-\s+(.+)$/);

            if (indent === 0 && keyMatch) {
                const storeName = this.parseBusinessYamlScalar(keyMatch[1] || keyMatch[2] || keyMatch[3]);
                currentStore = {
                    name: storeName,
                    categories: {},
                    categoryOrder: [],
                    categoryIndex: new Map(),
                };
                stores.push(currentStore);
                currentCategory = null;
                continue;
            }

            if (indent > 0 && indent <= 4 && keyMatch && currentStore) {
                const category = this.parseBusinessYamlScalar(keyMatch[1] || keyMatch[2] || keyMatch[3]);
                currentCategory = category;
                if (!currentStore.categories[currentCategory]) {
                    currentStore.categories[currentCategory] = [];
                    currentStore.categoryOrder.push(currentCategory);
                }
                continue;
            }

            if (indent >= 2 && itemMatch && currentStore && currentCategory) {
                const item = this.parseBusinessYamlScalar(itemMatch[1]);
                if (item && !currentStore.categories[currentCategory].includes(item)) {
                    currentStore.categories[currentCategory].push(item);
                }
            }
        }

        for (const store of stores) ensureCategoryIndex(store);
        return stores;
    }

    parseBusinessYamlScalar(value) {
        if (value == null) return '';
        let result = String(value).trim();
        const commentIndex = result.search(/\s+#/);
        if (commentIndex >= 0) result = result.slice(0, commentIndex).trim();
        if (
            (result.startsWith('"') && result.endsWith('"')) ||
            (result.startsWith("'") && result.endsWith("'"))
        ) {
            result = result.slice(1, -1);
        }
        return result.replace(/\\"/g, '"').replace(/\\'/g, "'");
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

    getConfiguredCategoryLabels() {
        return Array.isArray(this.configuredLabelGroups.category)
            ? this.configuredLabelGroups.category
            : [];
    }

    getCategoryLabels() {
        const businessCategories = this.getBusinessCategoryOptions();
        return businessCategories.length > 0 ? businessCategories : this.getConfiguredCategoryLabels();
    }

    getCurrentBusinessStoreName() {
        return this.metadata && typeof this.metadata.storeName === 'string'
            ? this.metadata.storeName.trim()
            : '';
    }

    getCurrentBusinessCategoryStore() {
        const storeName = this.getCurrentBusinessStoreName();
        const normalized = this.normalizeLabelKey(storeName);
        if (!normalized) return null;
        return this.businessCategoryStoreIndex.get(normalized) || null;
    }

    getBusinessCategoryOptions() {
        const store = this.getCurrentBusinessCategoryStore();
        return store && Array.isArray(store.categoryOrder) ? store.categoryOrder : [];
    }

    getBusinessSubcategoryOptions(category) {
        const store = this.getCurrentBusinessCategoryStore();
        if (!store || !category) return [];
        const normalized = this.normalizeLabelKey(category);
        const canonicalCategory = store.categoryIndex.get(normalized);
        return canonicalCategory && Array.isArray(store.categories[canonicalCategory])
            ? store.categories[canonicalCategory]
            : [];
    }

    normalizeSubcategoryValues(value) {
        if (Array.isArray(value)) {
            return [...new Set(value
                .map(item => typeof item === 'string' ? item.trim() : '')
                .filter(Boolean))];
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed ? [trimmed] : [];
        }
        return [];
    }

    getSubcategoryDisplayText(value) {
        return this.getDisplayTextList(this.normalizeSubcategoryValues(value)).join(', ');
    }

    getTranslationTableUrl() {
        return typeof window !== 'undefined' && typeof window.LAYOUT_TRANSLATION_TABLE_URL === 'string'
            ? window.LAYOUT_TRANSLATION_TABLE_URL
            : '';
    }

    annotationSupportsBusinessCategory(ann) {
        if (!ann || !ann.attribute) return false;
        return ['fixture', 'aisle', 'area', 'category'].includes(ann.attribute);
    }

    getAisleDirectionOptions() {
        return ['Left', 'Right', 'Top', 'Bottom', 'Both'];
    }

    normalizeAisleDirection(value) {
        if (typeof value !== 'string') return '';
        const normalized = value.trim().toLowerCase();
        const map = {
            left: 'Left',
            right: 'Right',
            top: 'Top',
            bottom: 'Bottom',
            both: 'Both',
        };
        return map[normalized] || '';
    }

    inferAisleDirectionFromText(...values) {
        for (const value of values) {
            if (typeof value !== 'string') continue;
            const normalized = value.trim().toLowerCase();
            if (!normalized) continue;
            if (/\bboth\b/.test(normalized)) return 'Both';
            if (/\bleft\b/.test(normalized)) return 'Left';
            if (/\bright\b/.test(normalized)) return 'Right';
            if (/\btop\b/.test(normalized)) return 'Top';
            if (/\bbottom\b/.test(normalized)) return 'Bottom';
        }
        return '';
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

        // Check group metadata color first (new label_metadata schema)
        const meta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[normalizedAttribute];
        if (meta && meta.color) {
            accentColor = meta.color;
        } else if (normalizedAttribute === 'category') {
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

    getSplitBoxTheme() {
        return this.getLabelTheme('SplitBox', 'fixture') || {
            accentColor: '#2980b9',
            borderColor: '#2980b9',
            backgroundColor: 'rgba(41, 128, 185, 0.12)',
            pickerBorderColor: 'rgba(41, 128, 185, 0.45)',
            pickerBackgroundColor: 'rgba(41, 128, 185, 0.12)',
            labelColor: '#2980b9',
            labelTextColor: '#ffffff',
        };
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

    applySplitBoxTheme(boxEl) {
        if (!boxEl) return;

        const theme = this.getSplitBoxTheme();
        if (!theme) return;

        boxEl.style.setProperty('--annotation-border-color', theme.borderColor || theme.accentColor);
        boxEl.style.setProperty('--annotation-box-bg', theme.backgroundColor || this.hexToRgba(theme.accentColor, 0.12));
        boxEl.style.setProperty('--split-region-border-color', theme.pickerBorderColor || theme.borderColor || theme.accentColor);
        boxEl.style.setProperty('--split-region-bg', theme.backgroundColor || this.hexToRgba(theme.accentColor, 0.12));
        boxEl.style.setProperty('--split-region-bg-hover', this.hexToRgba(theme.accentColor, 0.16));
        boxEl.style.setProperty('--split-region-label-color', theme.accentColor);
        boxEl.style.setProperty('--split-divider-color', this.hexToRgba(theme.accentColor, 0.90));
        boxEl.style.setProperty('--split-divider-shadow', `0 0 0 1px rgba(255, 255, 255, 0.75), 0 0 5px ${this.hexToRgba(theme.accentColor, 0.38)}`);
    }

    applySplitRegionLabelLayout(labelEl, text, boxWidthPx, boxHeightPx) {
        if (!labelEl) return;

        const labelLayout = this.getAnnotationLabelLayout(text, boxWidthPx, boxHeightPx);
        labelEl.classList.toggle('split-region-label--vertical', labelLayout.orientation === 'vertical');
        labelEl.classList.toggle('split-region-label--horizontal', labelLayout.orientation !== 'vertical');

        if (labelLayout.orientation === 'vertical') {
            labelEl.style.maxWidth = `${Math.max(0, boxHeightPx - 8)}px`;
            labelEl.style.maxHeight = `${Math.max(0, boxWidthPx - 8)}px`;
        } else {
            labelEl.style.maxWidth = `${Math.max(0, boxWidthPx - 8)}px`;
            labelEl.style.maxHeight = `${Math.max(0, boxHeightPx - 8)}px`;
        }

        this.populateAnnotationLabelContent(labelEl, text, labelLayout.orientation);
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

        const groupNames = this.configuredLabelGroupNames.filter(g => {
            // Exclude pure attribute groups (level 6) from the label picker tabs
            const meta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[g];
            return !(meta && meta.type === 'attribute');
        });
        const hasGroups = groupNames.length > 0;
        if (!hasGroups) picker.classList.add('label-picker--no-tabs');
        let activeTabIndex = 0;
        const tabPanels = [];

        // Helper: get the labels array for the currently active tab
        const getActiveLabels = () => {
            if (!hasGroups) return this.configuredLabels;
            return this.configuredLabelGroups[groupNames[activeTabIndex]] || [];
        };

        // Helper: type icon for group
        const getTypeIcon = (groupName) => {
            const meta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[groupName];
            if (meta && meta.type === 'polygon') return '';
            return '□ ';
        };

        // --- Tab bar ---
        let tabBar = null;
        if (hasGroups) {
            tabBar = document.createElement('div');
            tabBar.className = 'label-picker-tabs';
            for (let t = 0; t < groupNames.length; t++) {
                const tab = document.createElement('button');
                tab.className = 'label-picker-tab' + (t === 0 ? ' active' : '');
                const meta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[groupNames[t]];
                const levelStr = meta && meta.level ? `L${meta.level}` : groupNames[t];
                tab.textContent = levelStr;
                tab.title = (meta && meta.level ? `L${meta.level}: ` : '') + groupNames[t];
                if (meta && meta.color) {
                    tab.style.setProperty('--tab-color', meta.color);
                }
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
                const groupMeta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[groupNames[t]];
                const typeIcon = groupMeta && groupMeta.type === 'polygon' ? '' : '';
                for (let i = 0; i < labels.length; i++) {
                    const label = labels[i];
                    const btn = document.createElement('button');
                    btn.className = 'label-picker-btn';
                    this.applyLabelPickerButtonColor(btn, label, groupNames[t]);
                    const numSpan = document.createElement('span');
                    numSpan.className = 'label-picker-num';
                    numSpan.textContent = `${i + 1}`;
                    const iconSpan = document.createElement('span');
                    iconSpan.className = 'label-picker-type-icon';
                    iconSpan.textContent = typeIcon;
                    iconSpan.style.cssText = 'margin-right:4px;opacity:0.6;font-size:10px;';
                    btn.appendChild(numSpan);
                    btn.appendChild(iconSpan);
                    btn.appendChild(document.createTextNode(this.getDisplayText(label).trim() || '—'));
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
                btn.appendChild(document.createTextNode(this.getDisplayText(label).trim() || '—'));
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
        this.pendingPolygon = null;
    }

    commitPendingBox(label, attribute) {
        this.pushHistory();
        const level = this.getLevelForGroup(attribute);

        if (this.pendingPolygon) {
            const { vertices } = this.pendingPolygon;
            // Boundary: enforce uniqueness
            if (label === 'Boundary') {
                this.annotations = this.annotations.filter(
                    a => !(a.type === 'polygon' && a.label === 'Boundary')
                );
            }
            const newAnn = {
                id: this.nextAnnotationId++,
                type: 'polygon',
                vertices,
                label: label || '',
                attribute: attribute || '',
                level,
                attributes: {}
            };
            this.annotations.push(newAnn);
            if (!this.checkBoundaryConstraint(newAnn)) {
                console.warn('Annotation extends outside Boundary');
            }
        } else if (this.pendingBox) {
            const { x, y, width, height } = this.pendingBox;
            const attrs = {};
            // Auto-number Shelf
            if (label === 'Shelf' || label === 'Wall shelf') {
                attrs.shelfNumber = this.getNextShelfNumber();
                attrs.side = 'Both';
            }
            const newAnn = {
                id: this.nextAnnotationId++,
                type: 'bbox',
                x, y, width, height,
                angle: 0,
                label: label || '',
                attribute: attribute || '',
                level,
                attributes: attrs
            };
            this.annotations.push(newAnn);
            if (!this.checkBoundaryConstraint(newAnn)) {
                console.warn('Annotation extends outside Boundary');
            }
            // Persist any new custom label
            if (label && !this.configuredLabels.includes(label)) {
                this.saveCustomLabel(label);
            }
        }
        this.hasUnsavedChanges = true;
        this.isBoxDrawMode = false;
        this.isSplitBoxDrawMode = false;
        this.canvas.style.cursor = 'grab';
        this.hideLabelPicker();
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    cancelPendingBox() {
        this.isBoxDrawMode = false;
        this.isSplitBoxDrawMode = false;
        this.isDrawingPolygon = false;
        this.polygonCurrentVertices = [];
        this.pendingBoxKind = 'bbox';
        this.canvas.style.cursor = 'grab';
        this.hideLabelPicker();
        this.renderAnnotationBoxes();
    }

    // ========================================================================
    // Split Bounding Boxes
    // ========================================================================

    createSplitLeaf(attrs = {}) {
        const rawType = attrs.regionType || attrs.label || 'Other';
        return {
            id: this.generateSplitNodeId('r'),
            kind: 'leaf',
            attributes: {
                regionType: rawType === 'Fixture' ? 'Other' : rawType,
                category: attrs.category || '',
                subcategory: this.normalizeSubcategoryValues(attrs.subcategory),
                aisle: attrs.aisle || '',
                side: this.normalizeAisleDirection(attrs.side) || '',
                notes: attrs.notes || '',
            },
        };
    }

    generateSplitNodeId(prefix = 'n') {
        return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    }

    createSplitNode(orientation, ratio, first, second) {
        return {
            id: this.generateSplitNodeId('s'),
            kind: 'split',
            orientation,
            ratio: this.clampSplitRatio(ratio),
            first,
            second,
        };
    }

    createDefaultSplitTree(width, height) {
        const leftOrTop = this.createSplitLeaf({ regionType: 'Endcap' });
        const centerA = this.createSplitLeaf({ regionType: 'Shelf' });
        const centerB = this.createSplitLeaf({ regionType: 'Shelf' });
        const rightOrBottom = this.createSplitLeaf({ regionType: 'Endcap' });

        if (Math.abs(width) > Math.abs(height)) {
            const middle = this.createSplitNode('horizontal', 0.5, centerA, centerB);
            const middleAndRight = this.createSplitNode('vertical', 0.9, middle, rightOrBottom);
            return this.createSplitNode('vertical', 1 / 10, leftOrTop, middleAndRight);
        }

        const middle = this.createSplitNode('vertical', 0.5, centerA, centerB);
        const middleAndBottom = this.createSplitNode('horizontal', 0.9, middle, rightOrBottom);
        return this.createSplitNode('horizontal', 1 / 10, leftOrTop, middleAndBottom);
    }

    canUpgradeBBoxToSplitBox(ann) {
        return !!ann
            && ann.type === 'bbox'
            && ann.attribute === 'fixture';
    }

    getBBoxSplitLeafAttributes(ann) {
        const attrs = ann && ann.attributes && typeof ann.attributes === 'object'
            ? ann.attributes
            : {};
        return {
            regionType: ann && ann.label ? ann.label : (attrs.regionType || 'Other'),
            category: attrs.category || '',
            subcategory: this.normalizeSubcategoryValues(attrs.subcategory),
            aisle: attrs.aisle || '',
            side: attrs.side || '',
            notes: attrs.notes || '',
        };
    }

    createTwoLeafSplitTree(baseAttrs = {}, orientation = 'horizontal', ratio = 0.5) {
        const splitOrientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
        const firstLeafAttrs = JSON.parse(JSON.stringify(baseAttrs || {}));
        const secondLeafAttrs = JSON.parse(JSON.stringify(baseAttrs || {}));
        return this.createSplitNode(
            splitOrientation,
            this.clampSplitRatio(ratio),
            this.createSplitLeaf(firstLeafAttrs),
            this.createSplitLeaf(secondLeafAttrs)
        );
    }

    upgradeBBoxToSplitBox(ann, orientation = 'horizontal') {
        if (!this.canUpgradeBBoxToSplitBox(ann)) return false;
        const baseAttrs = this.getBBoxSplitLeafAttributes(ann);
        const splitTree = this.createTwoLeafSplitTree(baseAttrs, orientation, 0.5);
        ann.type = 'split-bbox';
        ann.attributes = ann.attributes && typeof ann.attributes === 'object' ? ann.attributes : {};
        ann.attributes.splitTree = splitTree;
        this.selectedAnnotation = ann.id;
        this.selectedSplitRegion = {
            annotationId: ann.id,
            regionId: this.getFirstSplitLeafId(splitTree),
        };
        return true;
    }

    normalizeSplitTree(tree) {
        if (!tree || typeof tree !== 'object') return this.createSplitLeaf();
        const normalizeNode = (node) => {
            if (!node || typeof node !== 'object') return this.createSplitLeaf();
            if (node.kind === 'split') {
                const orientation = node.orientation === 'vertical' ? 'vertical' : 'horizontal';
                const rawRatio = Number.isFinite(node.ratio) ? node.ratio : parseFloat(node.ratio);
                node.id = node.id || this.generateSplitNodeId('s');
                node.kind = 'split';
                node.orientation = orientation;
                node.ratio = this.clampSplitRatio(Number.isFinite(rawRatio) ? rawRatio : 0.5);
                node.first = normalizeNode(node.first);
                node.second = normalizeNode(node.second);
                return node;
            }
            const attrs = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
            attrs.regionType = attrs.regionType || attrs.label || attrs.type || 'Other';
            if (attrs.regionType === 'Fixture') attrs.regionType = 'Other';
            attrs.category = attrs.category || '';
            attrs.subcategory = this.normalizeSubcategoryValues(attrs.subcategory);
            attrs.aisle = attrs.aisle || '';
            attrs.side = this.normalizeAisleDirection(attrs.side) || '';
            attrs.notes = attrs.notes || '';
            node.id = node.id || this.generateSplitNodeId('r');
            node.kind = 'leaf';
            node.attributes = attrs;
            return node;
        };
        return normalizeNode(tree);
    }

    clampSplitRatio(ratio) {
        if (!Number.isFinite(ratio)) return 0.5;
        return Math.max(0.02, Math.min(0.98, ratio));
    }

    getSplitRoot(ann) {
        if (!ann || ann.type !== 'split-bbox') return null;
        ann.attributes = ann.attributes || {};
        ann.attributes.splitTree = this.normalizeSplitTree(ann.attributes.splitTree);
        return ann.attributes.splitTree;
    }

    getSplitLayout(tree, rect) {
        const leaves = [];
        const dividers = [];
        const walk = (node, r) => {
            if (!node) return;
            if (node.kind !== 'split') {
                leaves.push({ node, rect: r });
                return;
            }
            const ratio = this.clampSplitRatio(node.ratio);
            if (node.orientation === 'vertical') {
                const firstW = r.width * ratio;
                const firstRect = { x: r.x, y: r.y, width: firstW, height: r.height };
                const secondRect = { x: r.x + firstW, y: r.y, width: r.width - firstW, height: r.height };
                dividers.push({ node, rect: r, x: r.x + firstW, y: r.y, orientation: 'vertical' });
                walk(node.first, firstRect);
                walk(node.second, secondRect);
            } else {
                const firstH = r.height * ratio;
                const firstRect = { x: r.x, y: r.y, width: r.width, height: firstH };
                const secondRect = { x: r.x, y: r.y + firstH, width: r.width, height: r.height - firstH };
                dividers.push({ node, rect: r, x: r.x, y: r.y + firstH, orientation: 'horizontal' });
                walk(node.first, firstRect);
                walk(node.second, secondRect);
            }
        };
        walk(tree, rect);
        return { leaves, dividers };
    }

    findSplitLeaf(tree, regionId) {
        if (!tree || !regionId) return null;
        if (tree.kind !== 'split') return tree.id === regionId ? tree : null;
        return this.findSplitLeaf(tree.first, regionId) || this.findSplitLeaf(tree.second, regionId);
    }

    findSplitNode(tree, nodeId) {
        if (!tree || !nodeId) return null;
        if (tree.id === nodeId) return tree;
        if (tree.kind !== 'split') return null;
        return this.findSplitNode(tree.first, nodeId) || this.findSplitNode(tree.second, nodeId);
    }

    splitLeaf(tree, regionId, orientation = 'horizontal') {
        const splitOrientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
        if (!tree || !regionId || tree.kind !== 'split') return false;
        if (tree.first && tree.first.kind !== 'split' && tree.first.id === regionId) {
            const attrs = JSON.parse(JSON.stringify(tree.first.attributes || {}));
            tree.first = this.createSplitNode(splitOrientation, 0.5, this.createSplitLeaf(attrs), this.createSplitLeaf(attrs));
            this.selectedSplitRegion = { annotationId: this.selectedAnnotation, regionId: tree.first.first.id };
            return true;
        }
        if (tree.second && tree.second.kind !== 'split' && tree.second.id === regionId) {
            const attrs = JSON.parse(JSON.stringify(tree.second.attributes || {}));
            tree.second = this.createSplitNode(splitOrientation, 0.5, this.createSplitLeaf(attrs), this.createSplitLeaf(attrs));
            this.selectedSplitRegion = { annotationId: this.selectedAnnotation, regionId: tree.second.first.id };
            return true;
        }
        return this.splitLeaf(tree.first, regionId, splitOrientation) || this.splitLeaf(tree.second, regionId, splitOrientation);
    }

    deleteSplitLeaf(tree, regionId) {
        if (!tree || tree.kind !== 'split') return { changed: false, replacement: tree, selectedLeafId: null };
        if (tree.first && tree.first.kind !== 'split' && tree.first.id === regionId) {
            return { changed: true, replacement: tree.second, selectedLeafId: this.getFirstSplitLeafId(tree.second) };
        }
        if (tree.second && tree.second.kind !== 'split' && tree.second.id === regionId) {
            return { changed: true, replacement: tree.first, selectedLeafId: this.getFirstSplitLeafId(tree.first) };
        }
        const firstResult = this.deleteSplitLeaf(tree.first, regionId);
        if (firstResult.changed) {
            tree.first = firstResult.replacement;
            return { changed: true, replacement: tree, selectedLeafId: firstResult.selectedLeafId };
        }
        const secondResult = this.deleteSplitLeaf(tree.second, regionId);
        if (secondResult.changed) {
            tree.second = secondResult.replacement;
            return { changed: true, replacement: tree, selectedLeafId: secondResult.selectedLeafId };
        }
        return { changed: false, replacement: tree, selectedLeafId: null };
    }

    getFirstSplitLeafId(tree) {
        if (!tree) return null;
        if (tree.kind !== 'split') return tree.id;
        return this.getFirstSplitLeafId(tree.first) || this.getFirstSplitLeafId(tree.second);
    }

    getSplitRegionTypeOptions() {
        const options = [];
        const add = (items) => {
            for (const item of items || []) {
                if (item && !options.includes(item)) options.push(item);
            }
        };
        add(this.configuredLabelGroups.fixture || []);
        add(this.configuredLabelGroups.aisle || []);
        if (options.length === 0) add(['Shelf', 'Wall Shelf', 'Cooler', 'Checkout-Shelf', 'Endcap', 'Counter', 'Island', 'Aisle', 'Other']);
        return options;
    }

    getSplitRegionAttribute(label) {
        if ((this.configuredLabelGroups.aisle || []).includes(label)) return 'aisle';
        if ((this.configuredLabelGroups.fixture || []).includes(label)) return 'fixture';
        return label === 'Aisle' ? 'aisle' : 'fixture';
    }

    getSplitRegionLabel(leaf) {
        const attrs = leaf && leaf.attributes ? leaf.attributes : {};
        const parts = [];
        const regionType = this.getDisplayText(attrs.regionType).trim();
        if (regionType) parts.push(regionType);

        const category = this.getDisplayText(attrs.category).trim();
        if (category) parts.push(category);

        const subcategoryText = this.getSubcategoryDisplayText(attrs.subcategory);
        if (subcategoryText) parts.push(subcategoryText);

        const aisle = this.getDisplayText(attrs.aisle || attrs.notes).trim();
        if (aisle) parts.push(`Aisle ${aisle}`);

        const side = this.normalizeAisleDirection(attrs.side);
        if (side) parts.push(side);
        return parts.join(' · ') || 'Region';
    }

    selectSplitRegion(annotationId, regionId) {
        this.selectedAnnotation = annotationId;
        this.selectedSplitRegion = { annotationId, regionId };
        this.renderAnnotationBoxes();
    }

    clearSelectedSplitRegionIfInvalid() {
        if (!this.selectedSplitRegion) return;
        const ann = this.annotations.find(a => a.id === this.selectedSplitRegion.annotationId);
        const leaf = ann ? this.findSplitLeaf(this.getSplitRoot(ann), this.selectedSplitRegion.regionId) : null;
        if (!leaf) this.selectedSplitRegion = null;
    }

    createSplitBoxAnnotation(box) {
        this.pushHistory();
        const newAnn = {
            id: this.nextAnnotationId++,
            type: 'split-bbox',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            angle: 0,
            label: '',
            attribute: 'fixture',
            level: this.getLevelForGroup('fixture'),
            attributes: {
                splitTree: this.createDefaultSplitTree(box.width, box.height),
            },
        };
        this.annotations.push(newAnn);
        this.selectedAnnotation = newAnn.id;
        this.selectedSplitRegion = { annotationId: newAnn.id, regionId: this.getFirstSplitLeafId(newAnn.attributes.splitTree) };
        this.hasUnsavedChanges = true;
        this.isSplitBoxDrawMode = false;
        this.pendingBoxKind = 'bbox';
        this.canvas.style.cursor = 'grab';
        if (!this.checkBoundaryConstraint(newAnn)) {
            console.warn('Annotation extends outside Boundary');
        }
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    addSplitToSelectedRegion(orientation = 'horizontal') {
        const splitOrientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
        const selectedAnn = this.annotations.find(a => a.id === this.selectedAnnotation);

        if (this.canUpgradeBBoxToSplitBox(selectedAnn)) {
            this.pushHistory();
            const upgraded = this.upgradeBBoxToSplitBox(selectedAnn, splitOrientation);
            if (upgraded) {
                this.hasUnsavedChanges = true;
                this.renderAnnotationBoxes();
                this.renderMapLegend();
            }
            return;
        }

        if (!this.selectedSplitRegion || this.selectedSplitRegion.annotationId !== this.selectedAnnotation) {
            alert('请先选择一个 split boundingbox 的子区域，或选中一个 fixture bbox 后再按 A / D。');
            return;
        }
        const ann = this.annotations.find(a => a.id === this.selectedSplitRegion.annotationId);
        if (!ann || ann.type !== 'split-bbox') return;
        const tree = this.getSplitRoot(ann);
        const leaf = this.findSplitLeaf(tree, this.selectedSplitRegion.regionId);
        if (!leaf) return;
        this.pushHistory();
        let changed = false;
        if (tree.kind !== 'split' && tree.id === leaf.id) {
            const attrs = JSON.parse(JSON.stringify(tree.attributes || {}));
            ann.attributes.splitTree = this.createSplitNode(splitOrientation, 0.5, this.createSplitLeaf(attrs), this.createSplitLeaf(attrs));
            this.selectedSplitRegion = { annotationId: ann.id, regionId: ann.attributes.splitTree.first.id };
            changed = true;
        } else {
            changed = this.splitLeaf(tree, leaf.id, splitOrientation);
        }
        if (changed) {
            this.hasUnsavedChanges = true;
            this.renderAnnotationBoxes();
        }
    }

    deleteSelectedSplitRegion() {
        if (!this.selectedSplitRegion) return false;
        const ann = this.annotations.find(a => a.id === this.selectedSplitRegion.annotationId);
        if (!ann || ann.type !== 'split-bbox') return false;
        const tree = this.getSplitRoot(ann);
        const leaf = this.findSplitLeaf(tree, this.selectedSplitRegion.regionId);
        if (!leaf) return false;
        if (!confirm(`Delete split region "${this.getSplitRegionLabel(leaf)}"?`)) return true;
        this.pushHistory();
        if (tree.kind !== 'split') {
            this.selectedSplitRegion = null;
        } else {
            const result = this.deleteSplitLeaf(tree, leaf.id);
            if (result.changed) {
                ann.attributes.splitTree = this.normalizeSplitTree(result.replacement);
                this.selectedSplitRegion = result.selectedLeafId ? { annotationId: ann.id, regionId: result.selectedLeafId } : null;
            }
        }
        this.hasUnsavedChanges = true;
        this.renderAnnotationBoxes();
        this.renderMapLegend();
        return true;
    }

    renderSplitRegionsForBox(box, el, widthPx, heightPx) {
        const root = this.getSplitRoot(box);
        if (!root) return;
        const { leaves, dividers } = this.getSplitLayout(root, { x: 0, y: 0, width: widthPx, height: heightPx });
        const selectedRegionId = this.selectedSplitRegion && this.selectedSplitRegion.annotationId === box.id
            ? this.selectedSplitRegion.regionId
            : null;

        const splitTheme = this.getSplitBoxTheme();

        this.attachSplitDividerHitTest(box, el, dividers, widthPx, heightPx);

        for (const leafInfo of leaves) {
            const leaf = leafInfo.node;
            const r = leafInfo.rect;
            const region = document.createElement('div');
            region.className = 'split-region';
            if (leaf.id === selectedRegionId) region.classList.add('split-region--selected');
            region.dataset.regionId = leaf.id;
            region.style.left = `${r.x}px`;
            region.style.top = `${r.y}px`;
            region.style.width = `${r.width}px`;
            region.style.height = `${r.height}px`;
            region.title = this.getSplitRegionLabel(leaf);

            if (splitTheme) {
                region.style.borderColor = splitTheme.pickerBorderColor || splitTheme.borderColor || splitTheme.accentColor;
                region.style.background = splitTheme.backgroundColor || this.hexToRgba(splitTheme.accentColor, 0.12);
                region.style.setProperty('--split-region-label-color', splitTheme.accentColor);
            }

            const text = document.createElement('span');
            text.className = 'split-region-label';
            const regionLabel = this.getSplitRegionLabel(leaf);
            if (splitTheme) {
                text.style.color = splitTheme.labelTextColor || '#fff';
            }
            this.applySplitRegionLabelLayout(text, regionLabel, r.width, r.height);
            region.appendChild(text);

            region.addEventListener('mousedown', (e) => {
                this.startAnnotationDrag(box.id, e, {
                    onClick: () => this.selectSplitRegion(box.id, leaf.id),
                    onDragStart: () => {
                        this.selectedAnnotation = box.id;
                        this.selectedSplitRegion = { annotationId: box.id, regionId: leaf.id };
                    },
                });
            });
            el.appendChild(region);
        }

        this.renderSplitDividersForBox(box, el, dividers, widthPx, heightPx);
    }

    attachSplitDividerHitTest(box, el, dividers, widthPx, heightPx) {
        // Use 2-D distance from the nearest point on each divider's line segment so that
        // the correct divider is chosen even when the cursor is near an intersection.
        const findDividerAt = (clientX, clientY) => {
            const local = this.getSplitBoxLocalPoint(el, box, clientX, clientY, widthPx, heightPx);
            const threshold = 3;
            let best = null;
            let bestDist = Infinity;
            for (const divider of dividers) {
                let dist;
                if (divider.orientation === 'vertical') {
                    // Line segment: x = divider.x, y ∈ [rect.y, rect.y + rect.height]
                    const perpDist = Math.abs(local.x - divider.x);
                    const offEnd = Math.max(0, divider.rect.y - local.y, local.y - (divider.rect.y + divider.rect.height));
                    dist = Math.sqrt(perpDist * perpDist + offEnd * offEnd);
                } else {
                    // Line segment: y = divider.y, x ∈ [rect.x, rect.x + rect.width]
                    const perpDist = Math.abs(local.y - divider.y);
                    const offEnd = Math.max(0, divider.rect.x - local.x, local.x - (divider.rect.x + divider.rect.width));
                    dist = Math.sqrt(perpDist * perpDist + offEnd * offEnd);
                }
                if (dist < bestDist) {
                    bestDist = dist;
                    best = divider;
                }
            }
            return bestDist <= threshold ? best : null;
        };

        // Build a Map from splitNodeId → divider for O(1) lookup
        const dividerByNodeId = new Map(dividers.map(d => [d.node.id, d]));

        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Prefer the divider whose DOM element the cursor is directly on (pixel-perfect).
            // Fall back to the 2D distance hit test for clicks slightly off the divider line.
            let divider = null;
            const targetEl = e.target && e.target.closest ? e.target.closest('.split-divider') : null;
            if (targetEl && dividerByNodeId.has(targetEl.dataset.splitNodeId)) {
                divider = dividerByNodeId.get(targetEl.dataset.splitNodeId);
            } else {
                divider = findDividerAt(e.clientX, e.clientY);
            }
            if (!divider) return;
            e.preventDefault();
            // stopImmediatePropagation prevents the box-drag handler (bubble phase, same el)
            // from also firing, which would move the whole annotation and call renderAnnotationBoxes().
            e.stopImmediatePropagation();
            this.startSplitDividerDrag(box, el, divider, widthPx, heightPx, e);
        }, true);

        el.addEventListener('mousemove', (e) => {
            // Don't interfere with cursor while a drag is in progress
            if (document.body.classList.contains('split-divider-dragging')) return;
            const divider = findDividerAt(e.clientX, e.clientY);
            el.style.cursor = divider
                ? (divider.orientation === 'vertical' ? 'col-resize' : 'row-resize')
                : '';
        }, true);

        el.addEventListener('mouseleave', () => {
            if (!document.body.classList.contains('split-divider-dragging')) {
                el.style.cursor = '';
            }
        });
    }

    // Return the total CSS rotation (radians) of an element, including all ancestor transforms.
    _getSplitBoxTotalRotation(el) {
        let totalRad = 0;
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
            const t = window.getComputedStyle(node).transform;
            if (t && t !== 'none') {
                const m = new DOMMatrix(t);
                totalRad += Math.atan2(m.b, m.a);
            }
        }
        return totalRad;
    }

    getSplitBoxLocalPoint(el, box, clientX, clientY, widthPx, heightPx) {
        // Use the element's actual bounding-rect center — correct under any CSS transform chain
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = clientX - centerX;
        const dy = clientY - centerY;

        // Accumulate total rotation from all ancestor CSS transforms
        const totalRad = this._getSplitBoxTotalRotation(el);
        const cos = Math.cos(totalRad);
        const sin = Math.sin(totalRad);
        return {
            x: widthPx / 2 + dx * cos + dy * sin,
            y: heightPx / 2 - dx * sin + dy * cos,
        };
    }

    renderSplitDividersForBox(box, el, dividers, widthPx, heightPx) {
        for (const divider of dividers) {
            const line = document.createElement('div');
            line.className = `split-divider split-divider--${divider.orientation}`;
            line.dataset.splitNodeId = divider.node.id;
            if (divider.orientation === 'vertical') {
                line.style.left = `${divider.x}px`;
                line.style.top = `${divider.rect.y}px`;
                line.style.height = `${divider.rect.height}px`;
            } else {
                line.style.left = `${divider.rect.x}px`;
                line.style.top = `${divider.y}px`;
                line.style.width = `${divider.rect.width}px`;
            }

            const tooltip = document.createElement('span');
            tooltip.className = 'split-divider-tooltip';
            tooltip.textContent = `${Math.round(divider.node.ratio * 100)}% / ${Math.round((1 - divider.node.ratio) * 100)}%`;
            line.appendChild(tooltip);

            line.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                this.startSplitDividerDrag(box, el, divider, widthPx, heightPx, e);
            });
            el.appendChild(line);
        }
    }

    // Lightweight in-place update of split regions/dividers during drag.
    // Does NOT recreate the outer container – only updates CSS of existing children.
    updateSplitBoxDOM(ann, containerEl, widthPx, heightPx) {
        const root = this.getSplitRoot(ann);
        if (!root) return;
        const { leaves, dividers } = this.getSplitLayout(root, { x: 0, y: 0, width: widthPx, height: heightPx });

        const regionEls = containerEl.querySelectorAll('.split-region');
        for (const leafInfo of leaves) {
            const r = leafInfo.rect;
            for (const regionEl of regionEls) {
                if (regionEl.dataset.regionId === leafInfo.node.id) {
                    regionEl.style.left   = `${r.x}px`;
                    regionEl.style.top    = `${r.y}px`;
                    regionEl.style.width  = `${r.width}px`;
                    regionEl.style.height = `${r.height}px`;
                    regionEl.title = this.getSplitRegionLabel(leafInfo.node);
                    const labelEl = regionEl.querySelector('.split-region-label');
                    if (labelEl) {
                        this.applySplitRegionLabelLayout(labelEl, this.getSplitRegionLabel(leafInfo.node), r.width, r.height);
                    }
                    break;
                }
            }
        }

        const dividerEls = containerEl.querySelectorAll('.split-divider');
        for (const divider of dividers) {
            for (const divEl of dividerEls) {
                if (divEl.dataset.splitNodeId === divider.node.id) {
                    if (divider.orientation === 'vertical') {
                        divEl.style.left   = `${divider.x}px`;
                        divEl.style.top    = `${divider.rect.y}px`;
                        divEl.style.height = `${divider.rect.height}px`;
                        divEl.style.width  = '';
                    } else {
                        divEl.style.left   = `${divider.rect.x}px`;
                        divEl.style.top    = `${divider.y}px`;
                        divEl.style.width  = `${divider.rect.width}px`;
                        divEl.style.height = '';
                    }
                    const tooltip = divEl.querySelector('.split-divider-tooltip');
                    if (tooltip) {
                        tooltip.textContent = `${Math.round(divider.node.ratio * 100)}% / ${Math.round((1 - divider.node.ratio) * 100)}%`;
                    }
                    break;
                }
            }
        }
    }

    startSplitDividerDrag(box, el, divider, widthPx, heightPx, startEvent) {
        const ann = this.annotations.find(a => a.id === box.id);
        const node = ann ? this.findSplitNode(this.getSplitRoot(ann), divider.node.id) : null;
        if (!ann || !node) return;

        this.selectedAnnotation = box.id;
        this.selectedSplitRegion = null;
        this.pushHistory();
        document.body.classList.add('split-divider-dragging');

        // ── Cache everything once at drag start ──────────────────────────────
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const totalRad = this._getSplitBoxTotalRotation(el);
        const cos = Math.cos(totalRad);
        const sin = Math.sin(totalRad);
        const pr = divider.rect;
        const isVertical = node.orientation === 'vertical';

        // Pre-cache child DOM elements as Maps to avoid querySelectorAll every frame
        const regionElMap = new Map();
        for (const re of el.querySelectorAll('.split-region')) {
            regionElMap.set(re.dataset.regionId, re);
        }
        const dividerElMap = new Map();
        for (const de of el.querySelectorAll('.split-divider')) {
            dividerElMap.set(de.dataset.splitNodeId, de);
        }

        const applyRatio = (clientX, clientY) => {
            const dx = clientX - centerX;
            const dy = clientY - centerY;
            const lx = widthPx / 2 + dx * cos + dy * sin;
            const ly = heightPx / 2 - dx * sin + dy * cos;
            node.ratio = this.clampSplitRatio(
                isVertical ? (lx - pr.x) / Math.max(1, pr.width)
                           : (ly - pr.y) / Math.max(1, pr.height)
            );
            // Use ann.attributes.splitTree directly to avoid getSplitRoot() re-normalizing
            // the tree on every call (which creates a new copy and makes `node` stale).
            const { leaves, dividers: allDividers } = this.getSplitLayout(
                ann.attributes.splitTree, { x: 0, y: 0, width: widthPx, height: heightPx }
            );
            for (const leafInfo of leaves) {
                const re = regionElMap.get(leafInfo.node.id);
                if (re) {
                    const r = leafInfo.rect;
                    re.style.left   = `${r.x}px`;
                    re.style.top    = `${r.y}px`;
                    re.style.width  = `${r.width}px`;
                    re.style.height = `${r.height}px`;
                    re.title = this.getSplitRegionLabel(leafInfo.node);
                    const labelEl = re.querySelector('.split-region-label');
                    if (labelEl) {
                        this.applySplitRegionLabelLayout(labelEl, this.getSplitRegionLabel(leafInfo.node), r.width, r.height);
                    }
                }
            }
            for (const d of allDividers) {
                const de = dividerElMap.get(d.node.id);
                if (de) {
                    if (d.orientation === 'vertical') {
                        de.style.left   = `${d.x}px`;
                        de.style.top    = `${d.rect.y}px`;
                        de.style.height = `${d.rect.height}px`;
                        de.style.width  = '';
                    } else {
                        de.style.left   = `${d.rect.x}px`;
                        de.style.top    = `${d.y}px`;
                        de.style.width  = `${d.rect.width}px`;
                        de.style.height = '';
                    }
                    const tip = de.querySelector('.split-divider-tooltip');
                    if (tip) tip.textContent = `${Math.round(d.node.ratio * 100)}% / ${Math.round((1 - d.node.ratio) * 100)}%`;
                }
            }
        };

        const onMouseMove = (me) => {
            me.preventDefault();
            applyRatio(me.clientX, me.clientY);
        };
        const onMouseUp = (me) => {
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
            document.body.classList.remove('split-divider-dragging');
            applyRatio(me.clientX, me.clientY); // apply the final position
            this.hasUnsavedChanges = true;
            this.renderAnnotationBoxes(); // full rebuild once on release
        };

        applyRatio(startEvent.clientX, startEvent.clientY); // apply start position immediately
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
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

        // Do not rotate user annotations here. Global map rotation only changes
        // map data; existing bbox / split-bbox / polygon labels stay fixed.

        this.rotationAngle += angleDeg;
        this.hasUnsavedChanges = true;
        this.hasUnsavedMapChanges = true;
        this.syncRotationSlider();

        // Update selected camera indicator to match rotated position
        if (this.selectedCamera !== null) {
            const newPose = this.getCameraPose(this.selectedCamera);
            if (newPose) {
                this.selectedIndicatorPose = { ...newPose };
                this.selectedIndicatorTargetPose = { ...newPose };
            }
        }

        // Rebuild GPU buffer and bounds cache after rotation modifies all positions
        const count = this.pointCloud.length;
        if (count > 0) {
            if (this.pointCloudBuffer.length !== count * 2) {
                this.pointCloudBuffer = new Float32Array(count * 2);
            }
            for (let i = 0; i < count; i++) {
                this.pointCloudBuffer[i * 2]     = this.pointCloud[i][0];
                this.pointCloudBuffer[i * 2 + 1] = this.pointCloud[i][1];
            }
        }
        this._dataBoundsCache = null; // invalidate — will be recomputed by _computeAndCacheBounds

        // Refresh all rendering
        this.pcCacheValid = false; // invalidate — point cloud data changed after rotation
        this.uploadPointCloud();
        this._computeAndCacheBounds();
        this.updateVisibleCameras();
        this.fitView();
        this.render();
        this.capturePointCloudCache();
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
        // Remove polygon vertex handles
        layer.querySelectorAll('.polygon-vertex-handle').forEach(el => el.remove());

        const fragment = document.createDocumentFragment();

        // Render saved annotation boxes (skip polygons — handled by renderPolygons)
        for (const box of this.annotations) {
            if (box.type === 'polygon') continue;
            if (!this.isAnnotationVisible(box)) continue;
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
                if (this.pendingBoxKind === 'split-bbox') el.classList.add('annotation-box--split-bbox');
                fragment.appendChild(el);
            }
        }

        // Render pending box while label picker is open
        if (this.pendingBox) {
            const el = this.createAnnotationBoxElement({ ...this.pendingBox, label: '' });
            if (el) {
                el.classList.add('annotation-box--preview');
                if (this.pendingBoxKind === 'split-bbox') el.classList.add('annotation-box--split-bbox');
                fragment.appendChild(el);
            }
        }

        layer.appendChild(fragment);

        // Render polygons (separate SVG layer)
        this.renderPolygons();

        // Update attributes panel
        this.updateAttributesPanel();
    }

    startAnnotationDrag(boxId, startEvent, options = {}) {
        if (!this.annotationMode || boxId === undefined || !startEvent || startEvent.button !== 0) return;

        startEvent.stopPropagation();
        startEvent.preventDefault();

        const ann = this.annotations.find(a => a.id === boxId);
        if (!ann) return;

        const { onClick = null, onDragStart = null } = options;
        const world = this.screenToWorld(startEvent.clientX, startEvent.clientY);

        this.isDraggingAnnotation = false;
        this.dragAnnotationId = boxId;
        this.dragAnnotationOffset = { dx: world.x - ann.x, dy: world.y - ann.y };
        this._dragStartScreen = { x: startEvent.clientX, y: startEvent.clientY };
        this._dragMoved = false;

        let dragStateApplied = false;
        const applyDragState = () => {
            if (dragStateApplied) return;
            dragStateApplied = true;
            this.selectedAnnotation = boxId;
            if (typeof onDragStart === 'function') onDragStart(ann);
        };

        const onMouseMove = (me) => {
            const dx = me.clientX - this._dragStartScreen.x;
            const dy = me.clientY - this._dragStartScreen.y;
            if (!this._dragMoved && (dx * dx + dy * dy) > 9) {
                this._dragMoved = true;
                this.isDraggingAnnotation = true;
                applyDragState();
            }
            if (this._dragMoved) {
                const w = this.screenToWorld(me.clientX, me.clientY);
                ann.x = w.x - this.dragAnnotationOffset.dx;
                ann.y = w.y - this.dragAnnotationOffset.dy;
                this.renderAnnotationBoxes();
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (!this._dragMoved) {
                if (typeof onClick === 'function') onClick(ann);
            } else {
                this.hasUnsavedChanges = true;
            }

            this.isDraggingAnnotation = false;
            this.dragAnnotationId = null;
            this.dragAnnotationOffset = null;
            this.renderAnnotationBoxes();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
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
        if (box.angle) {
            el.style.transform = `rotate(${box.angle}deg)`;
        }

        if (box.type === 'split-bbox') {
            el.classList.add('annotation-box--split-bbox');
            this.applySplitBoxTheme(el);
        }

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

        if (box.type === 'split-bbox' && box.id !== undefined) {
            this.renderSplitRegionsForBox(box, el, w, h);
        }

        const labelEl = document.createElement('div');
        labelEl.className = 'annotation-label';
        // For aisle annotations, show the notes number directly on the bbox
        let labelText = this.getDisplayText(box.label).trim() || (box.id !== undefined ? `#${box.id}` : '');
        if (box.type === 'split-bbox') labelText = '';
        if (box.attribute === 'aisle' && box.attributes) {
            const notes = this.getDisplayText(box.attributes.notes).trim();
            const side = this.normalizeAisleDirection(box.attributes.side);
            if (notes != null && notes !== '') labelText = `Aisle ${notes}`;
            if (side) labelText = labelText ? `${labelText} · ${side}` : side;
        }
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

            // Rotation handle: line stem + circular drag knob
            const rotateLine = document.createElement('div');
            rotateLine.className = 'annotation-rotate-line';
            el.appendChild(rotateLine);

            const rotateHandle = document.createElement('div');
            rotateHandle.className = 'annotation-rotate-handle';
            rotateHandle.title = 'Drag to rotate';
            rotateHandle.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();

                const ann = this.annotations.find(a => a.id === box.id);
                if (!ann) return;

                // Screen center of the box element (stable across rotation)
                const rect = el.getBoundingClientRect();
                const screenCx = rect.left + rect.width / 2;
                const screenCy = rect.top + rect.height / 2;

                const startAngle = ann.angle || 0;
                const startMouseAngle = Math.atan2(e.clientY - screenCy, e.clientX - screenCx) * 180 / Math.PI;
                let rotated = false;

                const onMouseMove = (me) => {
                    const curAngle = Math.atan2(me.clientY - screenCy, me.clientX - screenCx) * 180 / Math.PI;
                    const delta = curAngle - startMouseAngle;
                    ann.angle = ((startAngle + delta) % 360 + 360) % 360;
                    rotated = true;
                    this.renderAnnotationBoxes();
                };
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    if (rotated) {
                        this.hasUnsavedChanges = true;
                        this.pushHistory();
                    }
                };
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
            el.appendChild(rotateHandle);
        }

        // Drag to move and click to select/deselect
        if (box.id !== undefined && this.annotationMode) {
            el.addEventListener('mousedown', (e) => {
                this.startAnnotationDrag(box.id, e, {
                    onClick: () => {
                        this.selectedAnnotation = this.selectedAnnotation === box.id ? null : box.id;
                        this.selectedSplitRegion = null;
                    },
                });
            });

            // Forward wheel events through the annotation box to the map canvas so
            // that zooming with the scroll wheel works even when the cursor is over a bbox.
            el.addEventListener('wheel', (e) => {
                this.onMapWheel(e);
            }, { passive: false });
        }

        return el;
    }

    startAnnotationResize(id, handlePos, e) {
        const ann = this.annotations.find(a => a.id === id);
        if (!ann) return;

        const angleRad = (ann.angle || 0) * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);

        // Current box center and half-extents
        const cx = ann.x + ann.width / 2;
        const cy = ann.y + ann.height / 2;
        const halfW = ann.width / 2;
        const halfH = ann.height / 2;

        // The "fixed" corner is opposite to the handle being dragged.
        // In local frame (box-axis-aligned): 'e' handle → fix west side at -halfW; 's' → fix north at -halfH
        const fixedU = handlePos.includes('e') ? -halfW : halfW;
        const fixedV = handlePos.includes('s') ? -halfH : halfH;

        // Transform fixed corner local → world  (CSS rotate convention: clockwise positive)
        const fixedWX = cx + fixedU * cos - fixedV * sin;
        const fixedWY = cy + fixedU * sin + fixedV * cos;

        let resized = false;
        const MIN_SIZE = 0.01;

        const onMouseMove = (me) => {
            const cur = this.screenToWorld(me.clientX, me.clientY);
            const dx = cur.x - fixedWX;
            const dy = cur.y - fixedWY;

            // Project world delta onto local axes to get new extents
            let dotU = dx * cos + dy * sin;    // extent along local x-axis
            let dotV = -dx * sin + dy * cos;   // extent along local y-axis

            // Clamp to prevent degenerate (zero-size) boxes
            if (Math.abs(dotU) < MIN_SIZE) dotU = (dotU >= 0 ? 1 : -1) * MIN_SIZE;
            if (Math.abs(dotV) < MIN_SIZE) dotV = (dotV >= 0 ? 1 : -1) * MIN_SIZE;

            const newW = Math.abs(dotU);
            const newH = Math.abs(dotV);

            // New center = fixed corner + half-diagonal in world space
            const halfDotU = dotU / 2;
            const halfDotV = dotV / 2;
            const newCx = fixedWX + halfDotU * cos - halfDotV * sin;
            const newCy = fixedWY + halfDotU * sin + halfDotV * cos;

            ann.x = newCx - newW / 2;
            ann.y = newCy - newH / 2;
            ann.width = newW;
            ann.height = newH;
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
        const displayLabel = ann ? this.getDisplayText(ann.label).trim() : '';
        const name = displayLabel ? `"${displayLabel}"` : `#${id}`;
        if (!confirm(`Delete annotation ${name}?`)) return;
        this.pushHistory();
        if (this.selectedAnnotation === id) this.selectedAnnotation = null;
        if (this.selectedSplitRegion && this.selectedSplitRegion.annotationId === id) this.selectedSplitRegion = null;
        this.annotations = this.annotations.filter(a => a.id !== id);
        this.hasUnsavedChanges = true;
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    hitTestAnnotation(wx, wy) {
        // Return the id of the topmost annotation containing (wx, wy), or null.
        for (let i = this.annotations.length - 1; i >= 0; i--) {
            const a = this.annotations[i];
            if (!this.isAnnotationVisible(a)) continue;
            if (a.type === 'polygon') {
                if (Array.isArray(a.vertices) && this.pointInPolygon(wx, wy, a.vertices)) return a.id;
            } else {
                if (wx >= a.x && wx <= a.x + a.width && wy >= a.y && wy <= a.y + a.height) {
                    return a.id;
                }
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

    sanitizeExportText(value) {
        if (value === null || value === undefined) return '';
        let result = String(value).normalize('NFKC').trim();
        if (!result) return '';

        result = result
            .replace(/\s*<[^<>]*[\u3400-\u9fff\uf900-\ufaff][^<>]*>\s*/gu, ' ')
            .replace(/\s*\([^()]*[\u3400-\u9fff\uf900-\ufaff][^()]*\)\s*/gu, ' ')
            .replace(/\s*（[^（）]*[\u3400-\u9fff\uf900-\ufaff][^（）]*）\s*/gu, ' ')
            .replace(/\s*\[[^\[\]]*[\u3400-\u9fff\uf900-\ufaff][^\[\]]*\]\s*/gu, ' ')
            .replace(/\s*【[^【】]*[\u3400-\u9fff\uf900-\ufaff][^【】]*】\s*/gu, ' ')
            .replace(/\s*「[^「」]*[\u3400-\u9fff\uf900-\ufaff][^「」]*」\s*/gu, ' ')
            .replace(/\s*『[^『』]*[\u3400-\u9fff\uf900-\ufaff][^『』]*』\s*/gu, ' ')
            .replace(CHINESE_TEXT_REGEX_GLOBAL, ' ')
            .replace(/[，。；：、！？]/gu, ' ')
            .replace(/<\s*>|\(\s*\)|（\s*）|\[\s*\]|【\s*】|「\s*」|『\s*』/gu, ' ')
            .replace(/\s*([·/,:;|])\s*/g, ' $1 ')
            .replace(/(?:^|\s)[·/,:;|](?=\s|$)/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[·/,:;|\s]+|[·/,:;|\s]+$/g, '')
            .trim();

        return result;
    }

    escapeXml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    makeExportSlug(value, fallback = 'item') {
        const clean = this.sanitizeExportText(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return clean || fallback;
    }

    getExportStoreId() {
        if (typeof window !== 'undefined' && window.LAYOUT_STORE_ID) {
            return String(window.LAYOUT_STORE_ID);
        }
        const base = this.dataBaseUrl || '';
        const match = base.match(/\/store_layout\/([^/]+)\//);
        if (match) {
            try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
        }
        return this.getExportBaseNameByParentDir().replace(/^viewer_/, '') || 'unknown';
    }

    getExportStoreName() {
        return this.sanitizeExportText(this.metadata && this.metadata.storeName) || this.getExportStoreId();
    }

    getSvgExportUnitInfo() {
        if (this.baseRatio !== null && this.baseRatio > 0) {
            return {
                scale: this.baseRatio,
                units: this.calibrationUnit || 'm',
                calibrated: true,
            };
        }
        return { scale: 1, units: 'px', calibrated: false };
    }

    getRotatedRectPoints(x, y, width, height, angleDeg, centerX = null, centerY = null) {
        const points = [
            { x, y },
            { x: x + width, y },
            { x: x + width, y: y + height },
            { x, y: y + height },
        ];
        const angle = Number(angleDeg) || 0;
        if (!angle) return points;

        const cx = centerX === null ? x + width / 2 : centerX;
        const cy = centerY === null ? y + height / 2 : centerY;
        const rad = angle * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return points.map(pt => {
            const dx = pt.x - cx;
            const dy = pt.y - cy;
            return {
                x: cx + dx * cos - dy * sin,
                y: cy + dx * sin + dy * cos,
            };
        });
    }

    getFixtureTypeForExport(label) {
        const normalized = this.sanitizeExportText(label).toLowerCase().replace(/[\s/-]+/g, '_');
        const map = {
            shelf: 'shelf',
            aisle: 'aisle',
            wall_shelf: 'wall_shelf',
            island: 'island',
            cooler: 'cooler',
            refrigerator: 'refrigerator',
            counter: 'counter',
            endcap: 'endcap',
            entrance: 'entrance',
            exit: 'exit',
            entrance_exit: 'entrance_exit',
            checkout: 'checkout_lane',
            checkout_shelf: 'checkout_shelf',
            checkout_lane: 'checkout_lane',
            pharmacy: 'pharmacy',
            restroom: 'restroom',
            other: 'other',
        };
        return map[normalized] || 'other';
    }

    isWalkableFixtureType(fixtureType) {
        return ['entrance', 'exit', 'entrance_exit'].includes(String(fixtureType || '').toLowerCase());
    }

    supportsAisleFixtureMetadata(fixtureType) {
        return [
            'shelf',
            'wall_shelf',
            'endcap',
            'checkout_shelf',
            'cooler',
            'refrigerator',
        ].includes(String(fixtureType || '').toLowerCase());
    }

    getExportZoneType(label) {
        const normalized = this.sanitizeExportText(label).toLowerCase();
        if (normalized.includes('checkout')) return 'checkout';
        if (normalized.includes('pharmacy')) return 'pharmacy';
        if (normalized.includes('other')) return 'other';
        return 'department';
    }

    getExportAisleSide(attrs = {}, fallback = '') {
        const side = this.sanitizeExportText(
            this.normalizeAisleDirection(attrs.side)
            || this.inferAisleDirectionFromText(
                attrs.side,
                attrs.notes,
                attrs.category,
                attrs.regionType,
                attrs.label,
            )
            || attrs.side
            || ''
        );
        return side || fallback;
    }

    getExportAisleLabel(attrs = {}, fallback = '') {
        return this.sanitizeExportText(attrs.aisle || attrs.notes || '') || String(fallback || '');
    }

    getExportFixtureName(attrs = {}, fallback = '') {
        return this.sanitizeExportText(attrs.category || fallback || '');
    }

    getExportSubcategory(attrs = {}) {
        return this.normalizeSubcategoryValues(attrs && attrs.subcategory)
            .map(value => this.sanitizeExportText(value))
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index)
            .join(', ');
    }

    getExportBasemapFilename(svgFilename) {
        return String(svgFilename || 'level-1.svg').replace(/\.svg$/i, '-basemap.png');
    }

    getExportIdToken(value, fallback = 'item') {
        return this.makeExportSlug(value, fallback).replace(/_/g, '-');
    }

    getExportLayerInfo(ann, attrs = {}) {
        const label = this.sanitizeExportText(attrs.regionType || ann.label || '');
        const attr = typeof ann.attribute === 'string' ? ann.attribute.trim().toLowerCase() : '';
        const normalizedLabel = label.toLowerCase().replace(/[\s/-]+/g, '_');

        if (attr === 'boundary' || ann.level === 1 || normalizedLabel === 'boundary') {
            return { layer: 'boundary', subtype: 'boundary', label };
        }
        if (attr === 'inner-structure' || ann.level === 2 || normalizedLabel === 'inner_wall') {
            return { layer: 'inner-walls', subtype: 'inner-wall', label };
        }
        if (attr === 'area' || ann.level === 5) {
            return { layer: 'zones', subtype: 'zone', label };
        }
        if (attr === 'aisle' || ann.level === 4 || normalizedLabel === 'aisle' || normalizedLabel.includes('corridor') || normalizedLabel === 'walk_aisle') {
            return { layer: 'virtual', subtype: 'walk_corridor', label };
        }
        return { layer: 'fixtures', subtype: this.getFixtureTypeForExport(label || ann.label), label };
    }

    buildExportDataAttributes(ann, attrs, elemId, layerInfo, sequence = '') {
        const data = {
            'data-id': elemId,
        };

        if (layerInfo.layer === 'boundary') {
            data['data-type'] = 'boundary';
            data['data-is-walkable'] = 'false';
        } else if (layerInfo.layer === 'inner-walls') {
            data['data-type'] = 'inner-wall';
            data['data-is-walkable'] = 'false';
        } else if (layerInfo.layer === 'fixtures') {
            const fixtureType = layerInfo.subtype || 'other';
            const category = this.getExportFixtureName(attrs, '');
            const subcategory = this.getExportSubcategory(attrs);
            const aisle = this.sanitizeExportText(attrs.aisle || attrs.notes || '');
            const side = this.getExportAisleSide(attrs, '');

            data['data-type'] = 'fixture';
            data['data-fixture-type'] = fixtureType;
            data['data-is-walkable'] = this.isWalkableFixtureType(fixtureType) ? 'true' : 'false';
            if (aisle && this.supportsAisleFixtureMetadata(fixtureType)) {
                data['data-label'] = aisle;
                if (category) data['data-name'] = category;
                if (subcategory) data['data-subcategory'] = subcategory;
                if (side) data['data-aisle-side'] = side.toLowerCase();
            }
        } else if (layerInfo.layer === 'virtual') {
            const aisle = this.getExportAisleLabel(attrs, sequence);
            data['data-type'] = 'walkable_aisle';
            data['data-is-walkable'] = 'true';
            if (aisle) data['data-label'] = aisle;
        } else {
            const zoneName = this.sanitizeExportText(attrs.category || layerInfo.label || ann.label || 'Other');
            data['data-type'] = 'zone';
            data['data-zone-type'] = this.getExportZoneType(zoneName);
            data['data-zone-name'] = zoneName || 'Other';
        }

        return data;
    }

    getExportElementLabel(ann, attrs, layerInfo) {
        if (layerInfo.layer === 'fixtures') {
            const parts = [];
            const fixtureLabel = this.sanitizeExportText(layerInfo.label || ann.label || '');
            const category = this.sanitizeExportText(attrs.category || '');
            const subcategory = this.getExportSubcategory(attrs);
            const aisle = this.sanitizeExportText(attrs.aisle || attrs.notes || '');
            const side = this.getExportAisleSide(attrs);
            if (fixtureLabel) parts.push(fixtureLabel);
            if (category) parts.push(category);
            if (subcategory) parts.push(subcategory);
            if (aisle) parts.push(`Aisle ${aisle}`);
            if (side) parts.push(side);
            return parts.join(' · ');
        }
        if (layerInfo.layer === 'zones') {
            return this.sanitizeExportText(attrs.category || layerInfo.label || ann.label || '');
        }
        if (layerInfo.layer === 'virtual') {
            const aisle = this.sanitizeExportText(attrs.aisle || attrs.notes || '');
            return aisle ? `Walkable Aisle ${aisle}` : 'Walkable Aisle';
        }
        return this.sanitizeExportText(layerInfo.label || ann.label || '');
    }

    getExportLayerStyle(layer, subtype) {
        if (layer === 'boundary') {
            return { fill: 'none', fillOpacity: '0', stroke: '#000000', strokeWidth: 3 };
        }
        if (layer === 'inner-walls') {
            return { fill: '#8e44ad', fillOpacity: '0.20', stroke: '#8e44ad', strokeWidth: 1.5 };
        }
        if (layer === 'fixtures') {
            const fixtureColors = {
                entrance: '#00A3A3',
                exit: '#009688',
                entrance_exit: '#00897B',
                aisle: '#2980b9',
                cooler: '#42D4F4',
                refrigerator: '#4FC3F7',
                checkout_lane: '#F58231',
                checkout_shelf: '#FB8C00',
                endcap: '#7E57C2',
                pharmacy: '#911EB4',
                restroom: '#469990',
                shelf: '#3B82F6',
                wall_shelf: '#4363D8',
            };
            const color = fixtureColors[subtype] || '#2980b9';
            return { fill: color, fillOpacity: '0.22', stroke: color, strokeWidth: 1.5 };
        }
        if (layer === 'virtual') {
            return { fill: '#27ae60', fillOpacity: '0.16', stroke: '#27ae60', strokeWidth: 1.5 };
        }
        return { fill: '#f39c12', fillOpacity: '0.18', stroke: '#f39c12', strokeWidth: 1.5 };
    }

    collectSvgExportItems() {
        const items = [];
        const usedIds = new Set();
        const counters = {
            boundary: 0,
            'inner-walls': 0,
            fixtures: 0,
            virtual: 0,
            zones: 0,
        };

        const uniqueId = (baseId) => {
            let id = baseId;
            let suffix = 2;
            while (usedIds.has(id)) {
                id = `${baseId}-${suffix}`;
                suffix += 1;
            }
            usedIds.add(id);
            return id;
        };

        const nextIdentity = (ann, attrs, layerInfo) => {
            counters[layerInfo.layer] = (counters[layerInfo.layer] || 0) + 1;
            const idx = counters[layerInfo.layer];
            let baseId;
            if (layerInfo.layer === 'boundary') {
                baseId = idx === 1 ? 'boundary-outer' : `boundary-outer-${idx}`;
            } else if (layerInfo.layer === 'inner-walls') {
                baseId = `inner-wall-${this.getExportIdToken(attrs.category || layerInfo.label || idx, String(idx))}`;
            } else if (layerInfo.layer === 'fixtures') {
                const subtype = layerInfo.subtype || 'other';
                {
                    const aisle = this.sanitizeExportText(attrs.aisle || attrs.notes || '');
                    const side = this.getExportAisleSide(attrs, '');
                    const name = this.getExportFixtureName(attrs, layerInfo.label || ann.label || 'fixture');
                    const subcategory = this.getExportSubcategory(attrs);
                    const idParts = ['fx', subtype];
                    if (aisle) idParts.push(this.getExportIdToken(aisle, String(idx)));
                    if (side) idParts.push(this.getExportIdToken(side, 'side'));
                    idParts.push(String(idx));
                    idParts.push(this.getExportIdToken(name, 'fixture'));
                    if (subcategory) idParts.push(this.getExportIdToken(subcategory, 'subcategory'));
                    baseId = idParts.join('-');
                }
            } else if (layerInfo.layer === 'virtual') {
                baseId = `walk-aisle-${this.getExportIdToken(this.getExportAisleLabel(attrs, idx), String(idx))}`;
            } else {
                baseId = `zone-${this.getExportIdToken(attrs.category || layerInfo.label || ann.label || 'zone', 'zone')}-${idx}`;
            }
            return { id: uniqueId(baseId), index: idx };
        };

        const addRectLike = (ann, x, y, width, height, attrs = {}) => {
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
            if (Math.abs(width) < 1e-9 || Math.abs(height) < 1e-9) return;
            const left = Math.min(x, x + width);
            const top = Math.min(y, y + height);
            const w = Math.abs(width);
            const h = Math.abs(height);
            const layerInfo = this.getExportLayerInfo(ann, attrs);
            const identity = nextIdentity(ann, attrs, layerInfo);
            const elemId = identity.id;
            const angle = Number(ann.angle) || 0;
            const parentCx = ann.x + ann.width / 2;
            const parentCy = ann.y + ann.height / 2;
            const points = this.getRotatedRectPoints(left, top, w, h, angle, parentCx, parentCy);
            const label = this.getExportElementLabel(ann, attrs, layerInfo);
            const data = this.buildExportDataAttributes(ann, attrs, elemId, layerInfo, identity.index);
            const style = this.getExportLayerStyle(layerInfo.layer, layerInfo.subtype);

            items.push({
                sourceId: ann.id,
                id: elemId,
                layer: layerInfo.layer,
                subtype: layerInfo.subtype,
                shape: angle ? 'polygon' : 'rect',
                x: left,
                y: top,
                width: w,
                height: h,
                points,
                label,
                attrs,
                sequence: identity.index,
                data,
                style,
            });
        };

        const addPolygon = (ann) => {
            if (!Array.isArray(ann.vertices) || ann.vertices.length < 3) return;
            const attrs = ann.attributes && typeof ann.attributes === 'object' ? ann.attributes : {};
            const points = ann.vertices
                .map((pt) => {
                    if (Array.isArray(pt)) {
                        return { x: Number(pt[0]), y: Number(pt[1]) };
                    }
                    if (pt && typeof pt === 'object') {
                        return { x: Number(pt.x), y: Number(pt.y) };
                    }
                    return { x: NaN, y: NaN };
                })
                .filter(pt => Number.isFinite(pt.x) && Number.isFinite(pt.y));
            if (points.length < 3) return;
            const layerInfo = this.getExportLayerInfo(ann, attrs);
            const identity = nextIdentity(ann, attrs, layerInfo);
            const elemId = identity.id;
            items.push({
                sourceId: ann.id,
                id: elemId,
                layer: layerInfo.layer,
                subtype: layerInfo.subtype,
                shape: 'polygon',
                points,
                label: this.getExportElementLabel(ann, attrs, layerInfo),
                attrs,
                sequence: identity.index,
                data: this.buildExportDataAttributes(ann, attrs, elemId, layerInfo, identity.index),
                style: this.getExportLayerStyle(layerInfo.layer, layerInfo.subtype),
            });
        };

        const walkSplitLeaves = (ann) => {
            const root = this.getSplitRoot(ann);
            if (!root) return;
            const { leaves } = this.getSplitLayout(root, { x: 0, y: 0, width: ann.width, height: ann.height });
            for (const leafInfo of leaves) {
                const attrs = leafInfo.node && leafInfo.node.attributes ? leafInfo.node.attributes : {};
                const rect = leafInfo.rect;
                addRectLike(ann, ann.x + rect.x, ann.y + rect.y, rect.width, rect.height, attrs);
            }
        };

        for (const ann of this.annotations || []) {
            if (!ann) continue;
            if (ann.type === 'split-bbox') {
                walkSplitLeaves(ann);
            } else if (ann.type === 'polygon') {
                addPolygon(ann);
            } else if (ann.type === 'bbox') {
                const attrs = ann.attributes && typeof ann.attributes === 'object' ? ann.attributes : {};
                addRectLike(ann, ann.x, ann.y, ann.width, ann.height, attrs);
            }
        }

        if (!items.some(item => item.layer === 'boundary')) {
            const bounds = this.getSvgItemsBounds(items);
            if (bounds) {
                usedIds.add('boundary-outer');
                items.unshift({
                    sourceId: null,
                    id: 'boundary-outer',
                    layer: 'boundary',
                    subtype: 'boundary',
                    shape: 'polygon',
                    points: [
                        { x: bounds.minX, y: bounds.minY },
                        { x: bounds.maxX, y: bounds.minY },
                        { x: bounds.maxX, y: bounds.maxY },
                        { x: bounds.minX, y: bounds.maxY },
                    ],
                    label: 'Boundary',
                    data: {
                        'data-id': 'boundary-outer',
                        'data-type': 'boundary',
                        'data-is-walkable': 'false',
                        'data-generated': 'annotation-bounds',
                    },
                    style: this.getExportLayerStyle('boundary', 'boundary'),
                });
            }
        }

        return items;
    }

    getSvgBoundaryBounds(items) {
        const boundaryItems = (items || []).filter(item => item.layer === 'boundary');
        return this.getSvgItemsBounds(boundaryItems) || this.getSvgItemsBounds(items);
    }

    getSvgItemsBounds(items) {
        const points = [];
        for (const item of items) {
            if (Array.isArray(item.points)) {
                points.push(...item.points);
            }
        }
        if (points.length === 0) return null;
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        return {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
        };
    }

    formatSvgNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '0';
        return num.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    }

    buildSvgAttributes(attrs) {
        return Object.entries(attrs)
            .filter(([, value]) => value !== null && value !== undefined && String(value) !== '')
            .map(([key, value]) => `${key}="${this.escapeXml(value)}"`)
            .join(' ');
    }

    getSvgExportLabelFontSize(unitInfo) {
        const scale = unitInfo && unitInfo.scale ? Number(unitInfo.scale) : 1;
        if (unitInfo && unitInfo.calibrated && Number.isFinite(scale) && scale > 0) {
            return Math.max(0.12, 14 * scale);
        }
        return 14;
    }

    buildSvgBasemapCanvas(sourceBounds, maxLongEdge = 2048) {
        if (!sourceBounds || !Array.isArray(this.pointCloud) || this.pointCloud.length === 0) return '';
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return '';

        const sourceWidth = Math.max(sourceBounds.maxX - sourceBounds.minX, 1);
        const sourceHeight = Math.max(sourceBounds.maxY - sourceBounds.minY, 1);
        const aspect = sourceWidth / sourceHeight;
        const canvas = document.createElement('canvas');

        if (aspect >= 1) {
            canvas.width = maxLongEdge;
            canvas.height = Math.max(1, Math.round(maxLongEdge / aspect));
        } else {
            canvas.height = maxLongEdge;
            canvas.width = Math.max(1, Math.round(maxLongEdge * aspect));
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return '';

        const scaleX = canvas.width / sourceWidth;
        const scaleY = canvas.height / sourceHeight;
        const pointRadius = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 1400));

        ctx.save();
        ctx.fillStyle = 'rgb(243, 236, 217)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(56, 56, 56, 0.82)';

        for (const pt of this.pointCloud) {
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const x = Number(pt[0]);
            const y = Number(pt[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (x < sourceBounds.minX || x > sourceBounds.maxX || y < sourceBounds.minY || y > sourceBounds.maxY) continue;

            const px = (x - sourceBounds.minX) * scaleX;
            const py = (y - sourceBounds.minY) * scaleY;
            ctx.beginPath();
            ctx.arc(px, py, pointRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
        return canvas;
    }

    async buildSvgBasemapPngBlob(sourceBounds, maxLongEdge = 2048) {
        const canvas = this.buildSvgBasemapCanvas(sourceBounds, maxLongEdge);
        if (!canvas || typeof canvas.toBlob !== 'function') return null;
        return await new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
    }

    getExportItemCentroid(item) {
        if (!item) return null;
        if (item.shape === 'rect' && Number.isFinite(item.x) && Number.isFinite(item.y)) {
            return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
        }
        const pts = Array.isArray(item.points) ? item.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
        if (pts.length === 0) return null;
        if (pts.length < 3) {
            const sx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            const sy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
            return { x: sx, y: sy };
        }
        let area = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < pts.length; i++) {
            const p0 = pts[i];
            const p1 = pts[(i + 1) % pts.length];
            const cross = p0.x * p1.y - p1.x * p0.y;
            area += cross;
            cx += (p0.x + p1.x) * cross;
            cy += (p0.y + p1.y) * cross;
        }
        area *= 0.5;
        if (Math.abs(area) < 1e-9) {
            const sx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            const sy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
            return { x: sx, y: sy };
        }
        return { x: cx / (6 * area), y: cy / (6 * area) };
    }

    buildExportLabelItems(items) {
        const labels = [];
        const usedIds = new Set();
        const otherCounters = new Map();
        for (const item of items) {
            const attrs = item.attrs || {};
            let text = '';
            let idPrefix = '';
            if (!item || (item.layer !== 'fixtures' && item.layer !== 'zones' && item.layer !== 'virtual')) continue;
            if (item.layer === 'zones') {
                const zoneName = this.sanitizeExportText((item.data && item.data['data-zone-name']) || attrs.category || item.label || '');
                if (!zoneName) continue;
                text = zoneName;
                const idx = (otherCounters.get('zone') || 0) + 1;
                otherCounters.set('zone', idx);
                idPrefix = `lbl-zone-${this.getExportIdToken(zoneName, 'zone')}-${idx}`;
            } else if (item.layer === 'virtual') {
                const aisleLabel = this.sanitizeExportText((item.data && item.data['data-label']) || attrs.aisle || attrs.notes || '');
                if (!aisleLabel) continue;
                text = aisleLabel;
                idPrefix = `lbl-aisle-${this.getExportIdToken(aisleLabel, String(item.sequence || 'n'))}`;
            } else {
                const fixtureType = item.subtype || (item.data && item.data['data-fixture-type']) || 'other';
                if (fixtureType === 'aisle') {
                    const aisleLabel = this.getExportAisleLabel(attrs, item.sequence);
                    text = aisleLabel;
                    idPrefix = `lbl-aisle-${this.getExportIdToken(aisleLabel, String(item.sequence || 'n'))}`;
                } else if (fixtureType === 'entrance' || fixtureType === 'exit' || fixtureType === 'entrance_exit') {
                    const fixtureTextMap = {
                        entrance: 'Entrance',
                        exit: 'Exit',
                        entrance_exit: 'Entrance/Exit',
                    };
                    text = fixtureTextMap[fixtureType] || 'Entrance';
                    const suffix = String(item.id || '').replace(/^fx-/, '');
                    idPrefix = `lbl-${fixtureType}-${this.getExportIdToken(suffix, String(item.sequence || 'n'))}`;
                } else {
                    const category = this.sanitizeExportText(attrs.category || '');
                    if (!category) continue;
                    text = category;
                    const idx = (otherCounters.get(fixtureType) || 0) + 1;
                    otherCounters.set(fixtureType, idx);
                    idPrefix = `lbl-${this.getExportIdToken(fixtureType, 'fixture')}-${this.getExportIdToken(category, 'category')}-${idx}`;
                }
            }
            if (!text) continue;
            const centroid = this.getExportItemCentroid(item);
            if (!centroid) continue;
            let labelId = idPrefix;
            let suffixCount = 2;
            while (usedIds.has(labelId)) {
                labelId = `${idPrefix}-${suffixCount}`;
                suffixCount += 1;
            }
            usedIds.add(labelId);
            labels.push({
                id: labelId,
                text,
                refId: item.id,
                x: centroid.x,
                y: centroid.y,
            });
        }
        return labels;
    }

    async buildDoorDashSvgExport() {
        const items = this.collectSvgExportItems();
        if (items.length === 0) return null;

        const bounds = this.getSvgBoundaryBounds(items);
        if (!bounds) return null;

        const unitInfo = this.getSvgExportUnitInfo();
        const scale = unitInfo.scale || 1;
        const width = Math.max((bounds.maxX - bounds.minX) * scale, 1);
        const height = Math.max((bounds.maxY - bounds.minY) * scale, 1);
        const storeId = this.getExportStoreId();
        const storeName = this.getExportStoreName();
        const filename = `${storeId}-level-1.svg`;
        const basemapFilename = this.getExportBasemapFilename(filename);
        const basemapBlob = await this.buildSvgBasemapPngBlob(bounds);
        const hasBasemap = Boolean(basemapBlob);
        const layerOrder = [
            ['boundary', 'outer-boundary', 'boundary'],
            ['inner-walls', 'layer-inner-walls', 'inner-walls'],
            ['fixtures', 'layer-fixtures', 'fixtures'],
            ['zones', 'layer-zones', 'zones'],
            ['virtual', 'layer-virtual', 'virtual'],
        ];

        const pointToSvg = (pt) => ({
            x: (pt.x - bounds.minX) * scale,
            y: (pt.y - bounds.minY) * scale,
        });

        const renderItem = (item) => {
            const sw = this.formatSvgNumber(item.style.strokeWidth * scale);
            const common = {
                id: item.id,
                fill: item.style.fill,
                'fill-opacity': item.style.fillOpacity,
                stroke: item.style.stroke,
                'stroke-width': sw,
                ...item.data,
            };

            const normalizedPoints = item.points.map(pointToSvg);

            if (item.shape === 'rect' && item.layer !== 'boundary' && item.layer !== 'virtual') {
                const x = (item.x - bounds.minX) * scale;
                const y = (item.y - bounds.minY) * scale;
                return `    <rect ${this.buildSvgAttributes({
                    ...common,
                    x: this.formatSvgNumber(x),
                    y: this.formatSvgNumber(y),
                    width: this.formatSvgNumber(item.width * scale),
                    height: this.formatSvgNumber(item.height * scale),
                })}/>`;
            }

            const pointsAttr = normalizedPoints
                .map(p => `${this.formatSvgNumber(p.x)},${this.formatSvgNumber(p.y)}`)
                .join(' ');
            return `    <polygon ${this.buildSvgAttributes({ ...common, points: pointsAttr })}/>`;
        };

        const rootAttrs = {
            xmlns: 'http://www.w3.org/2000/svg',
            viewBox: `0 0 ${this.formatSvgNumber(width)} ${this.formatSvgNumber(height)}`,
            width: this.formatSvgNumber(width),
            height: this.formatSvgNumber(height),
            'data-schema': 'clobotics_store_delivery',
            'data-schema-version': '1.0',
            'data-store-id': storeId,
            'data-store-name': storeName,
            'data-vendor': 'clobotics',
            'data-delivery': 'doordash-store-layout',
            'data-units': unitInfo.units,
        };
        if (unitInfo.calibrated) rootAttrs['data-scale'] = this.formatSvgNumber(scale);

        const lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<svg ${this.buildSvgAttributes(rootAttrs)}>`,
            '  <g id="layer-basemap" data-layer="basemap">',
        ];
        if (hasBasemap) {
            lines.push(`    <image ${this.buildSvgAttributes({
                href: basemapFilename,
                x: '0',
                y: '0',
                width: this.formatSvgNumber(width),
                height: this.formatSvgNumber(height),
                preserveAspectRatio: 'none',
                'data-source': 'point-cloud-png',
                'data-role': 'qa_alignment_only',
            })}/>`);
        }
        lines.push('  </g>');

        for (const [layerKey, groupId, dataLayer] of layerOrder) {
            lines.push(`  <g id="${groupId}" data-layer="${dataLayer}">`);
            for (const item of items.filter(it => it.layer === layerKey)) {
                lines.push(renderItem(item));
            }
            lines.push('  </g>');
        }

        const labelItems = this.buildExportLabelItems(items);
        const labelFontSize = Math.max(Math.max(width, height) * 0.006, 0.05);
        lines.push('  <g id="layer-labels" data-layer="labels">');
        for (const label of labelItems) {
            const lx = (label.x - bounds.minX) * scale;
            const ly = (label.y - bounds.minY) * scale;
            const attrs = {
                id: label.id,
                'data-id': label.id,
                'data-type': 'label',
                'data-ref-ids': label.refId,
                x: this.formatSvgNumber(lx),
                y: this.formatSvgNumber(ly),
                'text-anchor': 'middle',
                'dominant-baseline': 'middle',
                'font-size': this.formatSvgNumber(labelFontSize),
                'font-family': 'sans-serif',
                fill: '#111',
                'pointer-events': 'none',
            };
            lines.push(`    <text ${this.buildSvgAttributes(attrs)}>${this.escapeXml(label.text)}</text>`);
        }
        lines.push('  </g>');
        lines.push('</svg>');

        const svg = lines.join('\n') + '\n';
        const layerCounts = {
            basemap: hasBasemap ? 1 : 0,
            boundary: items.filter(item => item.layer === 'boundary').length,
            'inner-walls': items.filter(item => item.layer === 'inner-walls').length,
            fixtures: items.filter(item => item.layer === 'fixtures').length,
            zones: items.filter(item => item.layer === 'zones').length,
            virtual: items.filter(item => item.layer === 'virtual').length,
            labels: labelItems.length,
        };
        const metadata = this.buildStoreMetadataExport(
            filename,
            width,
            height,
            unitInfo,
            bounds,
            items.length,
            hasBasemap ? basemapFilename : null,
            layerCounts
        );
        return {
            svg,
            metadata,
            svgFilename: filename,
            basemapFilename: hasBasemap ? basemapFilename : null,
            basemapBlob: hasBasemap ? basemapBlob : null,
            metadataFilename: 'store-metadata.json',
            itemCount: items.length,
        };
    }

    buildStoreMetadataExport(svgFilename, width, height, unitInfo, sourceBounds, itemCount, basemapFilename = null, layerCounts = {}) {
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const coordinateSystem = {
            origin: 'top_left',
            view_box: [0, 0, width, height],
            note: unitInfo.calibrated
                ? `Coordinates are normalized to the outer boundary AABB. One SVG unit equals one ${unitInfo.units}; source viewer world units are multiplied by ${unitInfo.scale}.`
                : 'Coordinates are normalized to the outer boundary AABB in viewer world units. Calibrate scale before treating coordinates as physical distance.',
            source_bounds: {
                min_x: sourceBounds.minX,
                min_y: sourceBounds.minY,
                max_x: sourceBounds.maxX,
                max_y: sourceBounds.maxY,
            },
        };
        if (unitInfo.calibrated) {
            coordinateSystem.scale_per_world_unit = unitInfo.scale;
            coordinateSystem.scale_unit = unitInfo.units;
            coordinateSystem.svg_unit = unitInfo.units;
        }

        return {
            schema: 'clobotics_store_delivery',
            schema_version: '1.0',
            store_id: this.getExportStoreId(),
            store_name: this.getExportStoreName(),
            captured_at: now,
            units: unitInfo.units,
            coordinate_system: coordinateSystem,
            levels: [{
                level_id: '1',
                level_label: 'Ground Floor',
                is_default: true,
                svg_file: svgFilename,
                basemap_embedded: false,
                basemap_file: basemapFilename,
                basemap_source: basemapFilename ? 'point-cloud-png' : null,
                basemap_role: basemapFilename ? 'qa_alignment_only' : null,
                width,
                height,
            }],
            layer_counts: layerCounts,
            source: {
                vendor: 'clobotics',
                ingested_at: now,
                viewer_export: true,
                annotation_count: itemCount,
            },
        };
    }

    buildSvgPreviewHtml(svgFilename, svgContent, metadata) {
        const title = `${this.getExportStoreName()} SVG Preview`;
        const generatedAt = metadata && metadata.captured_at ? metadata.captured_at : new Date().toISOString();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeXml(title)}</title>
    <style>
        :root { color-scheme: light; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f5efe2; color: #2d261d; }
        header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 14px; background: rgba(255, 250, 240, 0.94); border-bottom: 1px solid #d9c8aa; box-shadow: 0 2px 12px rgba(70, 45, 20, 0.10); backdrop-filter: blur(8px); }
        h1 { margin: 0; font-size: 16px; }
        .meta { font-size: 12px; color: #6f604d; }
        .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
        button { border: 1px solid #cdb895; border-radius: 8px; padding: 6px 10px; background: #fff7e8; color: #3c2f20; cursor: pointer; font-weight: 600; }
        button:hover { background: #ffedc9; }
        .zoom-readout { min-width: 48px; text-align: center; font-size: 12px; color: #5d4d39; }
        .hint { font-size: 12px; color: #6f604d; }
        main { height: calc(100vh - 62px); display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; padding: 14px; }
        aside { overflow: auto; background: rgba(255, 250, 240, 0.86); border: 1px solid #d9c8aa; border-radius: 12px; box-shadow: 0 10px 28px rgba(70,45,20,.10); }
        .panel-title { position: sticky; top: 0; padding: 12px 14px; background: #fff6e7; border-bottom: 1px solid #e3d0ad; font-weight: 700; }
        .panel-section { padding: 10px 12px; border-bottom: 1px solid #ead9b9; }
        .section-title { margin: 0 0 8px; font-size: 12px; font-weight: 800; color: #69533a; text-transform: uppercase; letter-spacing: .04em; }
        .summary-grid { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; font-size: 12px; }
        .summary-grid span:nth-child(odd) { color: #6f604d; }
        .summary-grid span:nth-child(even) { font-weight: 700; text-align: right; }
        .layer-list { display: grid; gap: 2px; padding: 8px; }
        .layer-item { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 8px; font-size: 13px; cursor: pointer; }
        .layer-item:hover { background: #fff1d6; }
        .layer-item input { margin: 0; }
        .layer-name { flex: 1; }
        .layer-count { min-width: 28px; border-radius: 999px; padding: 1px 7px; background: #ead9b9; color: #5a4933; text-align: center; font-size: 11px; font-weight: 700; }
        .inspect-help { color: #7a6a55; font-size: 12px; line-height: 1.45; }
        .inspect-card { display: grid; gap: 8px; }
        .inspect-title { font-size: 13px; font-weight: 800; color: #3c2f20; }
        .inspect-badges { display: flex; flex-wrap: wrap; gap: 6px; }
        .inspect-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 3px 8px; background: #efe1c8; color: #4f3d2a; font-size: 11px; font-weight: 700; }
        .inspect-badge strong { color: #2f2418; }
        .attr-table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
        .attr-table th, .attr-table td { padding: 5px 4px; border-bottom: 1px solid #ead9b9; vertical-align: top; word-break: break-word; }
        .attr-table th { width: 44%; color: #6f604d; text-align: left; font-weight: 700; }
        .empty-note { color: #8a765b; font-size: 12px; font-style: italic; }
        .canvas { width: 100%; height: 100%; overflow: auto; background: #fffaf0; border: 1px solid #d9c8aa; border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.65), 0 12px 32px rgba(70,45,20,.12); cursor: grab; }
        .canvas.dragging { cursor: grabbing; }
        .svg-wrap { min-width: 100%; min-height: 100%; width: max-content; height: max-content; display: flex; align-items: flex-start; justify-content: center; padding: 24px; }
        .export-svg { display: block; flex: 0 0 auto; background: white; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.10); }
        .export-svg [data-id] { cursor: pointer; }
        .export-svg polygon { vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; stroke-opacity: 1 !important; stroke-width: max(0.06px, 1.25px) !important; }
        .export-svg [data-type="boundary"] { stroke-width: 3px !important; vector-effect: non-scaling-stroke; }
        .export-svg .preview-selected { outline: none; stroke: #ff2f00 !important; stroke-width: max(0.06px, 2px) !important; vector-effect: non-scaling-stroke; }
        code { background: #efe1c8; border-radius: 4px; padding: 2px 5px; }
        @media (max-width: 760px) {
            header { align-items: flex-start; flex-direction: column; }
            main { height: calc(100vh - 112px); grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
            aside { max-height: 180px; }
        }
    </style>
</head>
<body>
    <header>
        <div>
            <h1>${this.escapeXml(title)}</h1>
            <div class="meta">File: <code>${this.escapeXml(svgFilename)}</code> · Generated: ${this.escapeXml(generatedAt)}</div>
        </div>
        <div class="toolbar" aria-label="Preview controls">
            <button type="button" id="zoomOut">−</button>
            <span class="zoom-readout" id="zoomReadout">Fit</span>
            <button type="button" id="zoomIn">+</button>
            <button type="button" id="zoomFit">Fit</button>
            <button type="button" id="zoomActual">1×</button>
            <span class="hint">Drag to pan · Ctrl/⌘ + wheel to zoom</span>
        </div>
    </header>
    <main>
        <aside>
            <div class="panel-title">SVG Contract Preview</div>
            <div class="panel-section">
                <p class="section-title">Summary</p>
                <div class="summary-grid" id="summaryGrid"></div>
            </div>
            <div class="panel-section">
                <p class="section-title">Layers</p>
                <div class="layer-list" id="layerList"></div>
            </div>
            <div class="panel-section">
                <p class="section-title">Selected Element</p>
                <div id="inspector" class="inspect-help">Click a boundary, wall, fixture, walkable aisle, zone, or label to inspect its id and data-* attributes.</div>
            </div>
        </aside>
        <div class="canvas" id="canvas">
            <div class="svg-wrap" id="svgWrap">
${svgContent.replace(/^<\?xml[^>]*>\s*/i, '').trim()}
            </div>
        </div>
    </main>
    <script>
        (function () {
            const canvas = document.getElementById('canvas');
            const wrap = document.getElementById('svgWrap');
            const svg = wrap ? wrap.querySelector('svg') : null;
            const layerList = document.getElementById('layerList');
            const summaryGrid = document.getElementById('summaryGrid');
            const inspector = document.getElementById('inspector');
            const zoomReadout = document.getElementById('zoomReadout');
            if (!canvas || !wrap || !svg || !layerList || !summaryGrid || !inspector) return;

            svg.classList.add('export-svg');
            const viewBox = (svg.getAttribute('viewBox') || '0 0 1 1').trim().split(/\\s+/).map(Number);
            const vbWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : Number(svg.getAttribute('width')) || 1;
            const vbHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : Number(svg.getAttribute('height')) || 1;
            const layerLabels = {
                basemap: 'Basemap / PNG',
                boundary: 'Boundary',
                'inner-walls': 'Inner walls',
                fixtures: 'Fixtures',
                zones: 'Zones',
                virtual: 'Walkable aisles',
                labels: 'Labels'
            };
            const defaultVisible = { labels: false };
            const layerOrder = ['basemap', 'boundary', 'inner-walls', 'fixtures', 'zones', 'virtual', 'labels'];
            const layers = new Map();
            Array.from(svg.querySelectorAll('g[data-layer]')).forEach(function (group) {
                const key = group.getAttribute('data-layer');
                if (!layers.has(key)) layers.set(key, []);
                layers.get(key).push(group);
            });

            function layerElementCount(key) {
                const groups = layers.get(key) || [];
                return groups.reduce(function (sum, group) {
                    return sum + group.querySelectorAll('rect, polygon, path, image, text').length;
                }, 0);
            }

            function setSummary(label, value) {
                const k = document.createElement('span');
                const v = document.createElement('span');
                k.textContent = label;
                v.textContent = value;
                summaryGrid.appendChild(k);
                summaryGrid.appendChild(v);
            }

            const fixtureNodes = Array.from(svg.querySelectorAll('[data-type="fixture"]'));
            const basemapImage = svg.querySelector('[data-layer="basemap"] image');
            const walkableAisleNodes = Array.from(svg.querySelectorAll('[data-type="walkable_aisle"]'));
            const aisleBoundFixtureNodes = fixtureNodes.filter(function (el) { return !!el.getAttribute('data-label'); });
            setSummary('Schema', svg.getAttribute('data-schema') || '—');
            setSummary('Store', svg.getAttribute('data-store-id') || '—');
            setSummary('Units', svg.getAttribute('data-units') || '—');
            setSummary('viewBox', svg.getAttribute('viewBox') || '—');
            setSummary('Basemap', basemapImage ? (basemapImage.getAttribute('href') || 'external image') : '—');
            setSummary('Fixtures', String(fixtureNodes.length));
            setSummary('Walkable aisles', String(walkableAisleNodes.length));
            setSummary('Aisle-bound fixtures', String(aisleBoundFixtureNodes.length));
            setSummary('Zones', String(svg.querySelectorAll('[data-type="zone"]').length));
            setSummary('Layer 4', String(walkableAisleNodes.length));
            setSummary('Labels', String(svg.querySelectorAll('[data-type="label"]').length));

            layerOrder.filter(function (key) { return layers.has(key); }).forEach(function (key) {
                const item = document.createElement('label');
                item.className = 'layer-item';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = defaultVisible[key] !== false;
                const text = document.createElement('span');
                text.className = 'layer-name';
                text.textContent = layerLabels[key] || key;
                const count = document.createElement('span');
                count.className = 'layer-count';
                count.textContent = String(layerElementCount(key));
                item.appendChild(checkbox);
                item.appendChild(text);
                item.appendChild(count);
                layerList.appendChild(item);
                const applyLayerVisibility = function () {
                    layers.get(key).forEach(function (group) {
                        group.style.display = checkbox.checked ? '' : 'none';
                    });
                };
                checkbox.addEventListener('change', applyLayerVisibility);
                applyLayerVisibility();
            });

            if (!layerList.children.length) {
                const note = document.createElement('div');
                note.className = 'empty-note';
                note.textContent = 'No data-layer groups found.';
                layerList.appendChild(note);
            }

            let selectedElement = null;
            function renderInspector(el) {
                if (!el) {
                    inspector.className = 'inspect-help';
                    inspector.textContent = 'Click a boundary, wall, fixture, walkable aisle, zone, or label to inspect its id and data-* attributes.';
                    return;
                }
                inspector.className = 'inspect-card';
                const wrap = document.createElement('div');
                wrap.className = 'inspect-card';
                const title = document.createElement('div');
                title.className = 'inspect-title';
                title.textContent = el.getAttribute('id') || 'Selected element';
                wrap.appendChild(title);

                const badges = document.createElement('div');
                badges.className = 'inspect-badges';
                const badgeEntries = [
                    ['data-type', el.getAttribute('data-type')],
                    ['data-fixture-type', el.getAttribute('data-fixture-type')],
                    ['data-zone-type', el.getAttribute('data-zone-type')],
                    ['data-label', el.getAttribute('data-label')],
                    ['data-aisle-side', el.getAttribute('data-aisle-side')],
                    ['data-type', el.getAttribute('data-type') === 'walkable_aisle' ? 'walkable_aisle' : ''],
                ].filter(function (entry, index, list) {
                    if (!entry[1]) return false;
                    return list.findIndex(function (item) {
                        return item[0] === entry[0] && item[1] === entry[1];
                    }) === index;
                });
                badgeEntries.forEach(function (entry) {
                    const badge = document.createElement('span');
                    badge.className = 'inspect-badge';
                    const strong = document.createElement('strong');
                    strong.textContent = entry[0] + ':';
                    const value = document.createElement('span');
                    value.textContent = entry[1];
                    badge.appendChild(strong);
                    badge.appendChild(value);
                    badges.appendChild(badge);
                });
                if (badges.children.length) wrap.appendChild(badges);

                const table = document.createElement('table');
                table.className = 'attr-table';
                const attrs = Array.from(el.attributes)
                    .filter(function (attr) { return attr.name === 'id' || attr.name.indexOf('data-') === 0; })
                    .sort(function (a, b) {
                        if (a.name === 'id') return -1;
                        if (b.name === 'id') return 1;
                        return a.name.localeCompare(b.name);
                    });
                attrs.forEach(function (attr) {
                    const tr = document.createElement('tr');
                    const th = document.createElement('th');
                    const td = document.createElement('td');
                    th.textContent = attr.name;
                    td.textContent = attr.value;
                    tr.appendChild(th);
                    tr.appendChild(td);
                    table.appendChild(tr);
                });
                wrap.appendChild(table);
                inspector.replaceChildren(wrap);
            }

            Array.from(svg.querySelectorAll('[data-id]')).forEach(function (el) {
                el.addEventListener('click', function (event) {
                    event.stopPropagation();
                    if (selectedElement) selectedElement.classList.remove('preview-selected');
                    selectedElement = el;
                    selectedElement.classList.add('preview-selected');
                    renderInspector(el);
                });
            });
            svg.addEventListener('click', function () {
                if (selectedElement) selectedElement.classList.remove('preview-selected');
                selectedElement = null;
                renderInspector(null);
            });

            let fitScale = 1;
            let currentScale = 1;
            const minFactor = 0.15;
            const maxFactor = 16;

            function setSvgSize() {
                svg.style.width = Math.max(1, vbWidth * currentScale) + 'px';
                svg.style.height = Math.max(1, vbHeight * currentScale) + 'px';
                zoomReadout.textContent = Math.round((currentScale / fitScale) * 100) + '%';
            }

            function computeFitScale() {
                const availableW = Math.max(1, canvas.clientWidth - 64);
                const availableH = Math.max(1, canvas.clientHeight - 64);
                return Math.max(1, Math.min(availableW / vbWidth, availableH / vbHeight));
            }

            function fitToWindow() {
                fitScale = computeFitScale();
                currentScale = fitScale;
                setSvgSize();
                canvas.scrollLeft = Math.max(0, (wrap.scrollWidth - canvas.clientWidth) / 2);
                canvas.scrollTop = Math.max(0, (wrap.scrollHeight - canvas.clientHeight) / 2);
            }

            function zoomBy(multiplier, event) {
                const oldScale = currentScale;
                const oldWidth = vbWidth * oldScale;
                const oldHeight = vbHeight * oldScale;
                const rect = canvas.getBoundingClientRect();
                const focusX = event ? event.clientX - rect.left + canvas.scrollLeft - 24 : canvas.scrollLeft + canvas.clientWidth / 2 - 24;
                const focusY = event ? event.clientY - rect.top + canvas.scrollTop - 24 : canvas.scrollTop + canvas.clientHeight / 2 - 24;
                const ratioX = oldWidth > 0 ? focusX / oldWidth : 0.5;
                const ratioY = oldHeight > 0 ? focusY / oldHeight : 0.5;
                currentScale = Math.min(fitScale * maxFactor, Math.max(fitScale * minFactor, currentScale * multiplier));
                setSvgSize();
                canvas.scrollLeft = Math.max(0, ratioX * vbWidth * currentScale - (event ? event.clientX - rect.left : canvas.clientWidth / 2) + 24);
                canvas.scrollTop = Math.max(0, ratioY * vbHeight * currentScale - (event ? event.clientY - rect.top : canvas.clientHeight / 2) + 24);
            }

            document.getElementById('zoomOut').addEventListener('click', function () { zoomBy(1 / 1.25); });
            document.getElementById('zoomIn').addEventListener('click', function () { zoomBy(1.25); });
            document.getElementById('zoomFit').addEventListener('click', fitToWindow);
            document.getElementById('zoomActual').addEventListener('click', function () {
                currentScale = Math.max(1, fitScale);
                setSvgSize();
            });
            canvas.addEventListener('wheel', function (event) {
                if (!event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event);
            }, { passive: false });

            let dragging = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let scrollStartX = 0;
            let scrollStartY = 0;
            canvas.addEventListener('pointerdown', function (event) {
                dragging = true;
                dragStartX = event.clientX;
                dragStartY = event.clientY;
                scrollStartX = canvas.scrollLeft;
                scrollStartY = canvas.scrollTop;
                canvas.classList.add('dragging');
                canvas.setPointerCapture(event.pointerId);
            });
            canvas.addEventListener('pointermove', function (event) {
                if (!dragging) return;
                canvas.scrollLeft = scrollStartX - (event.clientX - dragStartX);
                canvas.scrollTop = scrollStartY - (event.clientY - dragStartY);
            });
            canvas.addEventListener('pointerup', function (event) {
                dragging = false;
                canvas.classList.remove('dragging');
                if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            });
            canvas.addEventListener('pointercancel', function () {
                dragging = false;
                canvas.classList.remove('dragging');
            });
            window.addEventListener('resize', function () {
                const factor = currentScale / fitScale;
                fitScale = computeFitScale();
                currentScale = fitScale * factor;
                setSvgSize();
            });

            fitToWindow();
        })();
    </script>
</body>
</html>
`;
    }

    async saveExportTextPayload(filename, content) {
        const saveUrl = typeof window !== 'undefined' && window.LAYOUT_EXPORT_SAVE_URL
            ? window.LAYOUT_EXPORT_SAVE_URL
            : `${this.saveBaseUrl}/save-export`;
        const resp = await fetch(saveUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content }),
        });
        if (!resp.ok) {
            const message = await resp.text().catch(() => resp.statusText);
            throw new Error(`Failed to save ${filename}: ${message || resp.status}`);
        }
        return await resp.json().catch(() => ({}));
    }

    async saveExportBlobPayload(filename, blob) {
        const saveUrl = typeof window !== 'undefined' && window.LAYOUT_EXPORT_SAVE_URL
            ? window.LAYOUT_EXPORT_SAVE_URL
            : `${this.saveBaseUrl}/save-export`;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const resp = await fetch(saveUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content_base64: btoa(binary) }),
        });
        if (!resp.ok) {
            const message = await resp.text().catch(() => resp.statusText);
            throw new Error(`Failed to save ${filename}: ${message || resp.status}`);
        }
        return await resp.json().catch(() => ({}));
    }

    downloadTextPayload(content, filename, type = 'text/plain;charset=utf-8') {
        const blob = new Blob([content], { type });
        this.downloadBlobPayload(blob, filename);
    }

    downloadBlobPayload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    makeCrc32Table() {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    }

    crc32(bytes) {
        if (!this._zipCrc32Table) this._zipCrc32Table = this.makeCrc32Table();
        let crc = 0xFFFFFFFF;
        for (const byte of bytes) {
            crc = this._zipCrc32Table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    dosDateTime(date = new Date()) {
        const year = Math.max(1980, date.getFullYear());
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
        const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        return { dosTime, dosDate };
    }

    writeZipUint16(out, value) {
        out.push(value & 0xFF, (value >>> 8) & 0xFF);
    }

    writeZipUint32(out, value) {
        out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
    }

    async getZipContentBytes(content) {
        const encoder = new TextEncoder();
        if (typeof content === 'string') return encoder.encode(content);
        if (content instanceof Uint8Array) return content;
        if (content instanceof ArrayBuffer) return new Uint8Array(content);
        if (ArrayBuffer.isView(content)) {
            return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        }
        if (typeof Blob !== 'undefined' && content instanceof Blob) {
            return new Uint8Array(await content.arrayBuffer());
        }
        return encoder.encode(String(content === undefined || content === null ? '' : content));
    }

    async createZipBlob(files) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        const now = this.dosDateTime();

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const dataBytes = await this.getZipContentBytes(file.content);
            const crc = this.crc32(dataBytes);
            const local = [];
            this.writeZipUint32(local, 0x04034b50);
            this.writeZipUint16(local, 20);
            this.writeZipUint16(local, 0x0800);
            this.writeZipUint16(local, 0);
            this.writeZipUint16(local, now.dosTime);
            this.writeZipUint16(local, now.dosDate);
            this.writeZipUint32(local, crc);
            this.writeZipUint32(local, dataBytes.length);
            this.writeZipUint32(local, dataBytes.length);
            this.writeZipUint16(local, nameBytes.length);
            this.writeZipUint16(local, 0);
            localParts.push(new Uint8Array(local), nameBytes, dataBytes);

            const central = [];
            this.writeZipUint32(central, 0x02014b50);
            this.writeZipUint16(central, 20);
            this.writeZipUint16(central, 20);
            this.writeZipUint16(central, 0x0800);
            this.writeZipUint16(central, 0);
            this.writeZipUint16(central, now.dosTime);
            this.writeZipUint16(central, now.dosDate);
            this.writeZipUint32(central, crc);
            this.writeZipUint32(central, dataBytes.length);
            this.writeZipUint32(central, dataBytes.length);
            this.writeZipUint16(central, nameBytes.length);
            this.writeZipUint16(central, 0);
            this.writeZipUint16(central, 0);
            this.writeZipUint16(central, 0);
            this.writeZipUint16(central, 0);
            this.writeZipUint32(central, 0);
            this.writeZipUint32(central, offset);
            centralParts.push(new Uint8Array(central), nameBytes);
            offset += local.length + nameBytes.length + dataBytes.length;
        }

        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const centralOffset = offset;
        const end = [];
        this.writeZipUint32(end, 0x06054b50);
        this.writeZipUint16(end, 0);
        this.writeZipUint16(end, 0);
        this.writeZipUint16(end, files.length);
        this.writeZipUint16(end, files.length);
        this.writeZipUint32(end, centralSize);
        this.writeZipUint32(end, centralOffset);
        this.writeZipUint16(end, 0);

        return new Blob([...localParts, ...centralParts, new Uint8Array(end)], { type: 'application/zip' });
    }

    async exportMapSvg() {
        const exportPayload = await this.buildDoorDashSvgExport();
        if (!exportPayload) {
            alert('No annotations available to export as SVG.');
            return;
        }

        const metadataJson = JSON.stringify(exportPayload.metadata, null, 2);
        const previewFilename = exportPayload.svgFilename.replace(/\.svg$/i, '-preview.html');
        const previewHtml = this.buildSvgPreviewHtml(exportPayload.svgFilename, exportPayload.svg, exportPayload.metadata);
        const zipFilename = exportPayload.svgFilename.replace(/\.svg$/i, '.zip');
        const packageFolder = `${this.getExportIdToken(this.getExportStoreId(), 'store')}/`;
        const zipFiles = [
            { name: `${packageFolder}${exportPayload.svgFilename}`, content: exportPayload.svg },
        ];
        if (exportPayload.basemapBlob && exportPayload.basemapFilename) {
            zipFiles.push({ name: `${packageFolder}${exportPayload.basemapFilename}`, content: exportPayload.basemapBlob });
        }
        zipFiles.push(
            { name: `${packageFolder}${exportPayload.metadataFilename}`, content: metadataJson },
            { name: `${packageFolder}${previewFilename}`, content: previewHtml },
        );
        const zipBlob = await this.createZipBlob(zipFiles);
        let serverSaved = false;
        let serverError = null;

        try {
            await this.saveExportTextPayload(exportPayload.svgFilename, exportPayload.svg);
            if (exportPayload.basemapBlob && exportPayload.basemapFilename) {
                await this.saveExportBlobPayload(exportPayload.basemapFilename, exportPayload.basemapBlob);
            }
            await this.saveExportTextPayload(exportPayload.metadataFilename, metadataJson);
            await this.saveExportTextPayload(previewFilename, previewHtml);
            await this.saveExportBlobPayload(zipFilename, zipBlob);
            serverSaved = true;
        } catch (error) {
            serverError = error;
            console.warn('Server export save failed; keeping local download backup:', error);
        }

        this.downloadBlobPayload(zipBlob, zipFilename);

        if (!serverSaved) {
            alert(`Export ZIP downloaded locally, but server save failed: ${serverError ? serverError.message : 'Unknown error'}`);
        }
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

        const labelData = this.buildLabelDataPayload();
        const mapData = this.buildMapDataPayload();
        const shouldSaveMap = this.hasUnsavedMapChanges || this.mapDataNeedsInitialSave;

        let labelGzipBytes;
        let mapGzipBytes = null;
        try {
            labelGzipBytes = await this.gzipJsonPayload(labelData);
            if (shouldSaveMap) {
                mapGzipBytes = await this.gzipJsonPayload(mapData);
            }
        } catch (e) {
            alert('Gzip compression not supported by this browser.');
            return;
        }

        // Try to save directly to server. Map data is saved first so a legacy
        // single-file store can safely migrate before the slim label file overwrites viewer_label.json.gz.
        try {
            if (shouldSaveMap) {
                await this.saveGzippedPayload(MAP_DATA_FILE, mapGzipBytes);
            }
            await this.saveGzippedPayload(LABEL_DATA_FILE, labelGzipBytes);

            const btn = document.getElementById('saveJsonBtn');
            btn.textContent = '✓ Saved';
            btn.style.color = 'green';
            setTimeout(() => { btn.textContent = 'Save JSON'; btn.style.color = ''; }, 2000);
            this.loadedMapFileName = MAP_DATA_FILE;
            this.loadedLabelFileName = LABEL_DATA_FILE;
            this.loadedDataFileName = LABEL_DATA_FILE;
            this.mapDataNeedsInitialSave = false;
            this.hasUnsavedMapChanges = false;
            this.hasUnsavedChanges = false;
            return;
        } catch (e) {
            // Server not running — fall through to download
        }

        // Fallback: download the gz files.
        if (shouldSaveMap && mapGzipBytes) {
            this.downloadGzipPayload(mapGzipBytes, MAP_DATA_FILE);
        }
        this.downloadGzipPayload(labelGzipBytes, LABEL_DATA_FILE);
        this.mapDataNeedsInitialSave = false;
        this.hasUnsavedMapChanges = false;
        this.hasUnsavedChanges = false;
    }

    buildMapDataPayload() {
        const data = {
            schemaVersion: 2,
            dataKind: 'store_layout_map',
            pointCloud: this.pointCloud,
            cameras: this.cameras.map(cam => ({ ...cam })),
            mapAnnotations: this.mapAnnotations,
            metadata: this.metadata || {},
            rotationApplied: this.rotationAngle,
            updatedAt: new Date().toISOString(),
        };

        // Preserve original map-adjacent fields
        if (this.matchPairs.length > 0) data.matchPairs = this.matchPairs;
        if (this.trackPairs.length > 0) data.trackPairs = this.trackPairs;
        if (Object.keys(this.recogData).length > 0) data.recogData = this.recogData;

        return data;
    }

    buildLabelDataPayload() {
        const data = {
            schemaVersion: 2,
            dataKind: 'store_layout_annotations',
            mapFile: MAP_DATA_FILE,
            annotations: this.annotations.map(a => ({ ...a })),
            savedAt: new Date().toISOString(),
        };

        // Save calibration / scale bar data
        if (this.baseRatio !== null) {
            data.scaleCalibration = {
                baseRatio: this.baseRatio,
                unit: this.calibrationUnit,
            };
        }

        return data;
    }

    async gzipJsonPayload(data) {
        const json = JSON.stringify(data);
        const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
    }

    async saveGzippedPayload(filename, gzipBytes) {
        const saveUrl = this.saveBaseUrl + '/save-data?filename=' + encodeURIComponent(filename);
        const resp = await fetch(saveUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: gzipBytes,
        });
        if (!resp.ok) {
            const message = await resp.text().catch(() => resp.statusText);
            throw new Error(`Failed to save ${filename}: ${message || resp.status}`);
        }
        return await resp.json().catch(() => ({}));
    }

    downloadGzipPayload(gzipBytes, filename) {
        const blob = new Blob([gzipBytes], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

        const englishOnlyToggle = document.getElementById('englishOnlyToggle');
        if (englishOnlyToggle) {
            englishOnlyToggle.addEventListener('change', (e) => {
                this.setEnglishOnly(e.target.checked);
                e.target.blur();
            });
        }

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

            // Polygon mode button
            const polygonModeBtn = document.getElementById('polygonModeBtn');
            if (polygonModeBtn) {
                polygonModeBtn.addEventListener('click', () => this.togglePolygonDrawMode());
            }

            // Undo / Redo buttons
            const undoBtn = document.getElementById('undoBtn');
            const redoBtn = document.getElementById('redoBtn');
            if (undoBtn) undoBtn.addEventListener('click', () => this.undo());
            if (redoBtn) redoBtn.addEventListener('click', () => this.redo());

            // Layer visibility toggle buttons
            document.querySelectorAll('.layer-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const level = parseInt(btn.dataset.level, 10);
                    this.toggleLayer(level);
                });
            });

            document.getElementById('exportMapPngBtn').addEventListener('click', () => {
                this.exportMapPng();
            });

            const exportSvgBtn = document.getElementById('exportMapSvgBtn');
            if (exportSvgBtn) {
                exportSvgBtn.addEventListener('click', async () => {
                    exportSvgBtn.textContent = 'Exporting…';
                    exportSvgBtn.disabled = true;
                    try {
                        await this.exportMapSvg();
                        exportSvgBtn.textContent = '✓ Exported';
                        exportSvgBtn.style.color = 'green';
                    } catch (error) {
                        console.error('Failed to export SVG:', error);
                        alert('Failed to export SVG: ' + (error.message || error));
                        exportSvgBtn.textContent = 'Export SVG';
                        exportSvgBtn.style.color = '';
                    } finally {
                        exportSvgBtn.disabled = false;
                        setTimeout(() => {
                            exportSvgBtn.textContent = 'Export SVG';
                            exportSvgBtn.style.color = '';
                        }, 2200);
                    }
                });
            }

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
                    this.loadedDataFileName = file.name || null;
                    this.loadedMapFileName = null;
                    this.loadedLabelFileName = file.name || null;
                    this.mapDataNeedsInitialSave = this.hasEmbeddedMapData(data);
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

        // Polygon draw mode: click to add vertex
        if (this.annotationMode && this.isDrawingPolygon && e.button === 0) {
            e.preventDefault();
            this.addPolygonVertex(world.x, world.y);
            return;
        }

        if (this.annotationMode && e.button === 0 && this.selectedAnnotation !== null) {
            const hitAnnotation = this.hitTestAnnotation(world.x, world.y);
            if (hitAnnotation === null) {
                this.selectedAnnotation = null;
                this.selectedSplitRegion = null;
                this.renderAnnotationBoxes();
            }
        }

        // Annotation mode + Ctrl or box draw mode: start drawing a box
        if (this.annotationMode && e.button === 0 && (this.isBoxDrawMode || this.isSplitBoxDrawMode || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.isDrawingBox = true;
            this.pendingBoxKind = this.isSplitBoxDrawMode ? 'split-bbox' : 'bbox';
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
        // Polygon draw mode: update live preview
        if (this.isDrawingPolygon) {
            this.polygonMouseWorld = this.screenToWorld(e.clientX, e.clientY);
            this.renderPolygons();
            return;
        }

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
            // Do not call updateVisibleCameras during drag: zoom is unchanged so visible set is the same.
            // It will be synced in onMapMouseUp when the drag ends.
            this.render();
            return;
        }

        // Hover detection — throttle to one check per animation frame
        this._pendingMouseMoveEvent = e;
        if (!this._rafMouseMoveScheduled) {
            this._rafMouseMoveScheduled = true;
            requestAnimationFrame(() => this._processMouseMove());
        }
    }

    _processMouseMove() {
        this._rafMouseMoveScheduled = false;
        const e = this._pendingMouseMoveEvent;
        this._pendingMouseMoveEvent = null;
        if (!e || this.isPanning || this.isDrawingBox || this.isDrawingPolygon) return;

        const world = this.screenToWorld(e.clientX, e.clientY);
        const hitCamera = this.hitTestCamera(world.x, world.y);
        if (hitCamera !== this.hoveredCamera) {
            this.hoveredCamera = hitCamera;
            this.canvas.style.cursor = (this.isBoxDrawMode || this.isSplitBoxDrawMode || this.companionMode) ? 'crosshair' : (hitCamera !== null ? 'pointer' : 'grab');
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

            if (this.pendingBoxKind === 'split-bbox') {
                this.createSplitBoxAnnotation({ x, y, width, height });
                return;
            }

            this.pendingBox = { x, y, width, height };
            this.showLabelPicker(e.clientX, e.clientY);
            return;
        }

        this.isPanning = false;
        this.dragWorldAnchor = null;
        // Sync visible cameras now that the drag is over (was skipped during drag for performance)
        this.updateVisibleCameras();
        this.render();
        // Refresh cache now that pan has settled
        this.capturePointCloudCache();
        this.render();
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
        // Finish polygon on double-click
        if (this.annotationMode && this.isDrawingPolygon) {
            e.preventDefault();
            this.finishPolygon(e.clientX, e.clientY);
            return;
        }

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
            // Refresh cache now that zoom has settled
            this.capturePointCloudCache();
            this.render();
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

            case 'b':
            case 'B':
                if (!this.readOnly && this.annotationMode) {
                    this.isBoxDrawMode = !this.isBoxDrawMode;
                    if (this.isBoxDrawMode) {
                        this.isDrawingPolygon = false;
                        this.isSplitBoxDrawMode = false;
                    }
                    this.canvas.style.cursor = this.isBoxDrawMode ? 'crosshair' : 'grab';
                    const polyBtn = document.getElementById('polygonModeBtn');
                    if (polyBtn) polyBtn.classList.remove('active');
                }
                break;

            case 'f':
            case 'F':
                if (!this.readOnly && this.annotationMode) {
                    this.isSplitBoxDrawMode = !this.isSplitBoxDrawMode;
                    if (this.isSplitBoxDrawMode) {
                        this.isBoxDrawMode = false;
                        this.isDrawingPolygon = false;
                    }
                    this.pendingBoxKind = this.isSplitBoxDrawMode ? 'split-bbox' : 'bbox';
                    this.canvas.style.cursor = this.isSplitBoxDrawMode ? 'crosshair' : 'grab';
                    const polyBtn = document.getElementById('polygonModeBtn');
                    if (polyBtn) polyBtn.classList.remove('active');
                }
                break;

            case 'a':
            case 'A':
                if (!this.readOnly && this.annotationMode) {
                    this.addSplitToSelectedRegion('horizontal');
                }
                break;

            case 'd':
            case 'D':
                if (!this.readOnly && this.annotationMode) {
                    this.addSplitToSelectedRegion('vertical');
                }
                break;

            case 'p':
            case 'P':
                if (!this.readOnly && this.annotationMode) {
                    this.togglePolygonDrawMode();
                }
                break;

            case 'z':
            case 'Z':
                if (!this.readOnly && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (e.shiftKey) this.redo(); else this.undo();
                }
                break;

            case 'y':
            case 'Y':
                if (!this.readOnly && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.redo();
                }
                break;

            case 'Escape':
                if (this.isDrawingPolygon) {
                    this.cancelPolygon();
                    break;
                }
                if (this.companionMode) {
                    this.toggleCompanionMode();
                    const dialog = document.getElementById('companionDialog');
                    if (dialog) dialog.remove();
                    break;
                }
                this.deselectCamera();
                if (!this.readOnly && this.selectedAnnotation !== null) {
                    this.selectedAnnotation = null;
                    this.selectedSplitRegion = null;
                    this.renderAnnotationBoxes();
                }
                break;

            case 'Delete':
            case 'Backspace':
                if (!this.readOnly && this.selectedCamera !== null) {
                    const selCam = this.cameras.find(c => c.id === this.selectedCamera);
                    if (selCam && selCam.overlayKind === 'companionPhoto') {
                        e.preventDefault();
                        this.removeCompanionCamera(this.selectedCamera);
                    }
                }
                break;

            case 'x':
            case 'X':
                if (!this.readOnly && this.annotationMode && this.selectedAnnotation !== null) {
                    if (this.deleteSelectedSplitRegion()) break;
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

    // ========================================================================
    // Level / Layer Helpers
    // ========================================================================

    getLevelForGroup(groupName) {
        const meta = this.configuredLabelGroupMeta && this.configuredLabelGroupMeta[groupName];
        if (meta && meta.level != null) return meta.level;
        // Legacy fallback
        const map = { boundary: 1, 'inner-structure': 2, fixture: 3, aisle: 4, area: 5, category: 6, location: 3 };
        return map[groupName] || 3;
    }

    isAnnotationVisible(ann) {
        const level = ann.level != null ? ann.level : 3;
        return this.layerVisibility[level] !== false;
    }

    toggleLayer(level) {
        this.layerVisibility[level] = !this.layerVisibility[level];
        document.querySelectorAll(`.layer-btn[data-level="${level}"]`).forEach(btn => {
            btn.classList.toggle('active', this.layerVisibility[level]);
        });
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    pointInPolygon(px, py, vertices) {
        // Ray-casting algorithm
        if (!vertices || vertices.length < 3) return false;
        let inside = false;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
            const xi = vertices[i][0], yi = vertices[i][1];
            const xj = vertices[j][0], yj = vertices[j][1];
            const intersect = ((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // ========================================================================
    // History (Undo / Redo)
    // ========================================================================

    pushHistory() {
        // Truncate redo history
        this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
        // Push snapshot
        this.historyStack.push(JSON.parse(JSON.stringify(this.annotations)));
        if (this.historyStack.length > this.historyMaxSize) {
            this.historyStack.shift();
        }
        this.historyIndex = this.historyStack.length - 1;
        this.updateUndoRedoButtons();
    }

    undo() {
        if (this.historyIndex <= 0) return;
        this.historyIndex--;
        this.annotations = JSON.parse(JSON.stringify(this.historyStack[this.historyIndex]));
        this.nextAnnotationId = this.annotations.reduce((max, a) => Math.max(max, (a.id || 0) + 1), this.nextAnnotationId);
        if (this.selectedAnnotation !== null && !this.annotations.find(a => a.id === this.selectedAnnotation)) {
            this.selectedAnnotation = null;
        }
        this.clearSelectedSplitRegionIfInvalid();
        this.hasUnsavedChanges = true;
        this.updateUndoRedoButtons();
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    redo() {
        if (this.historyIndex >= this.historyStack.length - 1) return;
        this.historyIndex++;
        this.annotations = JSON.parse(JSON.stringify(this.historyStack[this.historyIndex]));
        this.nextAnnotationId = this.annotations.reduce((max, a) => Math.max(max, (a.id || 0) + 1), this.nextAnnotationId);
        this.clearSelectedSplitRegionIfInvalid();
        this.hasUnsavedChanges = true;
        this.updateUndoRedoButtons();
        this.renderAnnotationBoxes();
        this.renderMapLegend();
    }

    updateUndoRedoButtons() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = this.historyIndex <= 0;
        if (redoBtn) redoBtn.disabled = this.historyIndex >= this.historyStack.length - 1;
    }

    // ========================================================================
    // Polygon Engine
    // ========================================================================

    togglePolygonDrawMode() {
        this.isDrawingPolygon = !this.isDrawingPolygon;
        const btn = document.getElementById('polygonModeBtn');
        if (this.isDrawingPolygon) {
            this.isBoxDrawMode = false;
            this.isSplitBoxDrawMode = false;
            this.polygonCurrentVertices = [];
            this.polygonMouseWorld = null;
            this.canvas.style.cursor = 'crosshair';
            if (btn) btn.classList.add('active');
        } else {
            this.cancelPolygon();
        }
    }

    cancelPolygon() {
        this.isDrawingPolygon = false;
        this.polygonCurrentVertices = [];
        this.polygonMouseWorld = null;
        this.canvas.style.cursor = 'grab';
        const btn = document.getElementById('polygonModeBtn');
        if (btn) btn.classList.remove('active');
        this.renderPolygons();
    }

    addPolygonVertex(wx, wy) {
        const verts = this.polygonCurrentVertices;
        // Check snap-to-start (close polygon)
        if (verts.length >= 3) {
            const snap = this.snapToPolygonStart(wx, wy);
            if (snap) {
                this.finishPolygonWithVertices(verts);
                return;
            }
        }
        verts.push([wx, wy]);
        this.renderPolygons();
    }

    snapToPolygonStart(wx, wy) {
        if (this.polygonCurrentVertices.length < 3) return false;
        const first = this.polygonCurrentVertices[0];
        const snap = this.worldToScreen(first[0], first[1]);
        const cur = this.worldToScreen(wx, wy);
        const dist = Math.hypot(snap.x - cur.x, snap.y - cur.y);
        return dist < this.polygonSnapThreshold;
    }

    finishPolygon(screenX, screenY) {
        const verts = this.polygonCurrentVertices;
        if (verts.length < 3) {
            this.cancelPolygon();
            return;
        }
        this.finishPolygonWithVertices(verts);
    }

    finishPolygonWithVertices(vertices) {
        const cloned = vertices.map(v => [v[0], v[1]]);
        this.isDrawingPolygon = false;
        this.polygonCurrentVertices = [];
        this.polygonMouseWorld = null;
        this.canvas.style.cursor = 'grab';
        const btn = document.getElementById('polygonModeBtn');
        if (btn) btn.classList.remove('active');

        this.pendingPolygon = { vertices: cloned };
        this.pendingBox = null;
        // Show label picker at center of polygon bounding box
        const xs = cloned.map(v => v[0]);
        const ys = cloned.map(v => v[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const sc = this.worldToScreen(cx, cy);
        this.showLabelPicker(sc.x, sc.y);
        this.renderPolygons();
    }

    renderPolygons() {
        const layer = document.getElementById('mapAnnotationLayer');
        if (!layer) return;

        // Get or create SVG overlay
        let svg = document.getElementById('annotationPolygonSVG');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = 'annotationPolygonSVG';
            svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:50';
            layer.appendChild(svg);
        }
        svg.innerHTML = '';

        // Remove old vertex handles
        layer.querySelectorAll('.polygon-vertex-handle').forEach(el => el.remove());

        const mapPanel = document.getElementById('mapPanel');
        const panelRect = mapPanel ? mapPanel.getBoundingClientRect() : null;

        // Render saved polygons
        for (const ann of this.annotations) {
            if (ann.type !== 'polygon') continue;
            if (!this.isAnnotationVisible(ann)) continue;
            if (!ann.vertices || ann.vertices.length < 2) continue;
            this.renderSavedPolygon(svg, layer, ann, panelRect);
        }

        // Render in-progress polygon drawing
        if (this.isDrawingPolygon && this.polygonCurrentVertices.length > 0) {
            this.renderDrawingPolygon(svg, layer, panelRect);
        }

        // Render pending polygon (waiting for label picker)
        if (this.pendingPolygon && this.pendingPolygon.vertices) {
            this.renderPendingPolygon(svg, this.pendingPolygon.vertices);
        }
    }

    renderSavedPolygon(svg, layer, ann, panelRect) {
        const verts = ann.vertices;
        const screenVerts = verts.map(v => this.worldToScreen(v[0], v[1]));
        const points = screenVerts.map(s => `${s.x},${s.y}`).join(' ');

        const isSelected = ann.id === this.selectedAnnotation;
        const theme = this.getLabelTheme(ann.label, ann.attribute);
        const fillColor = theme ? this.hexToRgba(theme.accentColor, ann.attribute === 'area' ? 0.18 : 0.10) : 'rgba(100,100,255,0.1)';
        const strokeColor = theme ? theme.accentColor : '#5050ff';
        const strokeWidth = isSelected ? 2.5 : (ann.attribute === 'boundary' ? 0 : 1.5);

        // Dashed outline for boundary
        const isBoundary = ann.attribute === 'boundary' || ann.label === 'Boundary';
        const dashArray = 'none';
        const boundaryStrokeColor = isBoundary ? '#000000' : strokeColor;
        const boundaryFill = isBoundary ? 'none' : fillColor;

        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', points);
        polygon.setAttribute('fill', boundaryFill);
        polygon.setAttribute('stroke', isSelected ? '#f0a030' : boundaryStrokeColor);
        polygon.setAttribute('stroke-width', isSelected ? '2.5' : (isBoundary ? '2' : strokeWidth));
        if (isSelected) polygon.setAttribute('stroke-dasharray', '5,3');
        // Boundary interior is click-through; only the stroke is interactive
        polygon.style.pointerEvents = this.annotationMode ? (isBoundary ? 'stroke' : 'all') : 'none';
        polygon.style.cursor = this.annotationMode ? 'move' : 'default';

        if (this.annotationMode) {
            polygon.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();

                const startWorld = this.screenToWorld(e.clientX, e.clientY);
                const startVerts = ann.vertices.map(v => [v[0], v[1]]); // snapshot
                const dragStart = { x: e.clientX, y: e.clientY };
                let dragMoved = false;
                let historyPushed = false;

                const onMove = (me) => {
                    const dx = me.clientX - dragStart.x;
                    const dy = me.clientY - dragStart.y;
                    if (!dragMoved && (dx * dx + dy * dy) > 9) {
                        dragMoved = true;
                        this.selectedAnnotation = ann.id;
                        if (!historyPushed) { this.pushHistory(); historyPushed = true; }
                    }
                    if (dragMoved) {
                        const curWorld = this.screenToWorld(me.clientX, me.clientY);
                        const wdx = curWorld.x - startWorld.x;
                        const wdy = curWorld.y - startWorld.y;
                        ann.vertices = startVerts.map(v => [v[0] + wdx, v[1] + wdy]);
                        this.renderAnnotationBoxes();
                    }
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (!dragMoved) {
                        // No drag — toggle selection
                        this.selectedAnnotation = this.selectedAnnotation === ann.id ? null : ann.id;
                    } else {
                        this.hasUnsavedChanges = true;
                    }
                    this.renderAnnotationBoxes();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        svg.appendChild(polygon);

        // Label text: boundary → top-left corner; others → centroid
        const displayLabel = this.getDisplayText(ann.label).trim();
        if (displayLabel) {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            if (isBoundary) {
                const bbMinX = Math.min(...screenVerts.map(v => v.x));
                const bbMinY = Math.min(...screenVerts.map(v => v.y));
                text.setAttribute('x', bbMinX + 8);
                text.setAttribute('y', bbMinY - 8);
                text.setAttribute('text-anchor', 'start');
                text.setAttribute('dominant-baseline', 'auto');
                text.setAttribute('stroke', '#000000');
            } else {
                const cx = screenVerts.reduce((s, v) => s + v.x, 0) / screenVerts.length;
                const cy = screenVerts.reduce((s, v) => s + v.y, 0) / screenVerts.length;
                text.setAttribute('x', cx);
                text.setAttribute('y', cy);
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('dominant-baseline', 'central');
                text.setAttribute('stroke', theme ? theme.accentColor : '#5050ff');
            }
            text.setAttribute('font-size', '14');
            text.setAttribute('font-weight', '700');
            text.setAttribute('fill', '#ffffff');
            text.setAttribute('paint-order', 'stroke');
            text.setAttribute('stroke-width', '4');
            text.style.pointerEvents = 'none';
            text.textContent = displayLabel;
            svg.appendChild(text);
        }

        // Delete button for selected polygon — positioned at bounding-box top-right
        if (isSelected && this.annotationMode) {
            const bbMaxX = Math.max(...screenVerts.map(v => v.x));
            const bbMinY = Math.min(...screenVerts.map(v => v.y));
            const delBtn = document.createElement('span');
            delBtn.className = 'annotation-delete polygon-vertex-handle';
            delBtn.textContent = '×';
            delBtn.title = 'Delete polygon';
            delBtn.style.cssText = `left:${bbMaxX - 8}px;top:${bbMinY - 10}px;right:auto;z-index:102;`;
            delBtn.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                this.deleteAnnotation(ann.id);
            });
            layer.appendChild(delBtn);

            // Vertex handles for editing
            screenVerts.forEach((sv, idx) => {
                const handle = document.createElement('div');
                handle.className = 'polygon-vertex-handle';
                handle.style.cssText = `
                    left:${sv.x - 5}px; top:${sv.y - 5}px;
                    width:10px; height:10px;
                    background:#f0a030; border:2px solid #fff;
                    border-radius:50%; cursor:move; z-index:103;
                `;
                handle.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    this.pushHistory();
                    const onMove = (me) => {
                        const w = this.screenToWorld(me.clientX, me.clientY);
                        ann.vertices[idx][0] = w.x;
                        ann.vertices[idx][1] = w.y;
                        this.renderAnnotationBoxes();
                    };
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        this.hasUnsavedChanges = true;
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
                layer.appendChild(handle);
            });
        }
    }

    renderDrawingPolygon(svg, layer, panelRect) {
        const verts = this.polygonCurrentVertices;
        const screenVerts = verts.map(v => this.worldToScreen(v[0], v[1]));
        const mouseScreen = this.polygonMouseWorld ? this.worldToScreen(this.polygonMouseWorld.x, this.polygonMouseWorld.y) : null;

        // Preview line to cursor
        const allPts = [...screenVerts];
        if (mouseScreen) allPts.push(mouseScreen);
        if (allPts.length >= 2) {
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', allPts.map(p => `${p.x},${p.y}`).join(' '));
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', '#f39c12');
            polyline.setAttribute('stroke-width', '1.5');
            polyline.setAttribute('stroke-dasharray', '6,3');
            polyline.style.pointerEvents = 'none';
            svg.appendChild(polyline);
        }

        // Vertex dots
        screenVerts.forEach((sv, idx) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', sv.x);
            circle.setAttribute('cy', sv.y);
            circle.setAttribute('r', idx === 0 ? 6 : 4);
            circle.setAttribute('fill', idx === 0 ? '#e74c3c' : '#f39c12');
            circle.setAttribute('stroke', '#fff');
            circle.setAttribute('stroke-width', '1.5');
            circle.style.pointerEvents = 'none';
            svg.appendChild(circle);
        });

        // Snap indicator at first vertex when close enough
        if (mouseScreen && verts.length >= 3) {
            const isSnapping = this.snapToPolygonStart(this.polygonMouseWorld.x, this.polygonMouseWorld.y);
            if (isSnapping) {
                const snapCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                snapCircle.setAttribute('cx', screenVerts[0].x);
                snapCircle.setAttribute('cy', screenVerts[0].y);
                snapCircle.setAttribute('r', 10);
                snapCircle.setAttribute('fill', 'none');
                snapCircle.setAttribute('stroke', '#e74c3c');
                snapCircle.setAttribute('stroke-width', '2');
                snapCircle.style.pointerEvents = 'none';
                svg.appendChild(snapCircle);
            }
        }
    }

    renderPendingPolygon(svg, vertices) {
        const screenVerts = vertices.map(v => this.worldToScreen(v[0], v[1]));
        const points = screenVerts.map(s => `${s.x},${s.y}`).join(' ');
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', points);
        polygon.setAttribute('fill', 'rgba(243,156,18,0.08)');
        polygon.setAttribute('stroke', '#f39c12');
        polygon.setAttribute('stroke-width', '1.5');
        polygon.setAttribute('stroke-dasharray', '6,3');
        polygon.style.pointerEvents = 'none';
        svg.appendChild(polygon);
    }

    // ========================================================================
    // Attributes Panel
    // ========================================================================

    updateAttributesPanel() {
        const panel = document.getElementById('attributesPanel');
        const content = document.getElementById('attributesPanelContent');
        if (!panel || !content) return;

        if (this.selectedAnnotation === null) {
            panel.style.display = 'none';
            delete panel.dataset.annotationId;
            delete panel.dataset.splitRegionId;
            return;
        }

        const ann = this.annotations.find(a => a.id === this.selectedAnnotation);
        if (!ann || !this.annotationMode) {
            panel.style.display = 'none';
            delete panel.dataset.annotationId;
            delete panel.dataset.splitRegionId;
            return;
        }

        let splitLeaf = null;
        if (this.selectedSplitRegion && this.selectedSplitRegion.annotationId === ann.id && ann.type === 'split-bbox') {
            splitLeaf = this.findSplitLeaf(this.getSplitRoot(ann), this.selectedSplitRegion.regionId);
            if (!splitLeaf) this.selectedSplitRegion = null;
        }

        // If the user is interacting with an input/select inside the panel,
        // skip rebuilding — re-render triggered by map pan/zoom would destroy
        // the focused element and close any open native dropdowns.
        const renderedAnnotationId = Number.parseInt(panel.dataset.annotationId || '', 10);
        const renderedSplitRegionId = panel.dataset.splitRegionId || '';
        const isSameAnnotation = renderedAnnotationId === ann.id;
        const isSameSplitRegion = (splitLeaf ? splitLeaf.id : '') === renderedSplitRegionId;
        if (panel.matches(':focus-within') && isSameAnnotation && isSameSplitRegion) return;

        panel.style.display = '';
        panel.dataset.annotationId = String(ann.id);
        if (splitLeaf) panel.dataset.splitRegionId = splitLeaf.id;
        else delete panel.dataset.splitRegionId;
        content.innerHTML = '';

        // Label header badge
        const badge = document.createElement('div');
        badge.className = 'attr-label-header';
        const theme = this.getLabelTheme(ann.label, ann.attribute);
        if (theme) {
            badge.style.background = theme.accentColor;
            badge.style.color = theme.labelTextColor || '#fff';
        }
        badge.textContent = splitLeaf
            ? this.getSplitRegionLabel(splitLeaf)
            : (this.getDisplayText(ann.label).trim() || `#${ann.id}`);
        content.appendChild(badge);

        if (splitLeaf) {
            const attrs = splitLeaf.attributes || (splitLeaf.attributes = {});
            const refreshSplitRegionDisplay = () => this.refreshAnnotationAttributeDisplay();
            const splitPrimaryRow = this.buildAttrRow('attr-row--three');
            splitPrimaryRow.appendChild(this.buildAttrSelect('regionType', 'Label / Type', this.getSplitRegionTypeOptions(), attrs, ann, refreshSplitRegionDisplay));
            this.appendBusinessCategoryFields(splitPrimaryRow, attrs, ann);
            content.appendChild(splitPrimaryRow);

            const splitSecondaryRow = this.buildAttrRow('attr-row--two');
            splitSecondaryRow.appendChild(this.buildAttrInput('aisle', 'Aisle ', 'aisle', attrs, ann, refreshSplitRegionDisplay));
            splitSecondaryRow.appendChild(this.buildAttrSelect(
                'side',
                'Direction',
                this.getAisleDirectionOptions(),
                attrs,
                ann,
                (value) => {
                    attrs.side = this.normalizeAisleDirection(value);
                    refreshSplitRegionDisplay();
                }
            ));
            content.appendChild(splitSecondaryRow);

            const splitNotesRow = this.buildAttrRow('attr-row--single');
            splitNotesRow.appendChild(this.buildAttrInput('notes', 'Notes', 'text', attrs, ann, refreshSplitRegionDisplay));
            content.appendChild(splitNotesRow);
            return;
        }

        const attrs = ann.attributes || (ann.attributes = {});
        attrs.subcategory = this.normalizeSubcategoryValues(attrs.subcategory);

        const labelOptions = this.getAnnotationLabelOptions(ann);
        if (labelOptions.length > 0) {
            const labelRow = this.buildAttrRow('attr-row--single');
            labelRow.appendChild(this.buildAnnotationLabelField(ann, labelOptions));
            content.appendChild(labelRow);
        }

        // Store-specific Category / Sub-category dropdowns for classifiable annotations.
        if (this.annotationSupportsBusinessCategory(ann)) {
            this.appendBusinessCategoryFields(content, attrs, ann);
        }

        // Shelf-specific fields
        if (ann.label === 'Shelf' || ann.label === 'Wall shelf') {
            content.appendChild(this.buildAttrInput('shelfNumber', 'Shelf #', 'aisle', attrs, ann));
            // For horizontal shelves (width > height), use Front/Back instead of Left/Right
            const isHorizontal = Math.abs(ann.width) > Math.abs(ann.height);
            const sideOptions = isHorizontal ? ['Both', 'Front', 'Back'] : ['Both', 'Left', 'Right'];
            content.appendChild(this.buildAttrSelect('side', 'Side', sideOptions, attrs, ann));
        }

        // Notes field: number or letter (A-Z) for aisle (displays on bbox), free text for others
        if (ann.attribute === 'aisle') {
            content.appendChild(this.buildAttrSelect(
                'side',
                'Direction',
                this.getAisleDirectionOptions(),
                attrs,
                ann,
                (value) => {
                    attrs.side = this.normalizeAisleDirection(value);
                    this.renderAnnotationBoxes();
                }
            ));
            content.appendChild(this.buildAttrInput('notes', 'Aisle ', 'aisle', attrs, ann, () => this.renderAnnotationBoxes()));
        } else {
            content.appendChild(this.buildAttrInput('notes', 'Notes', 'text', attrs, ann));
        }
    }

    updateAttributesHeaderLabel() {
        const panel = document.getElementById('attributesPanel');
        const content = document.getElementById('attributesPanelContent');
        if (!panel || !content) return;

        const badge = content.querySelector('.attr-label-header');
        if (!badge) return;

        const annotationId = Number.parseInt(panel.dataset.annotationId || '', 10);
        if (!Number.isFinite(annotationId)) return;

        const ann = this.annotations.find(a => a.id === annotationId);
        if (!ann) return;

        const splitRegionId = panel.dataset.splitRegionId || '';
        if (splitRegionId && ann.type === 'split-bbox') {
            const splitLeaf = this.findSplitLeaf(this.getSplitRoot(ann), splitRegionId);
            badge.textContent = splitLeaf
                ? this.getSplitRegionLabel(splitLeaf)
                : (this.getDisplayText(ann.label).trim() || `#${ann.id}`);
            return;
        }

        badge.textContent = this.getDisplayText(ann.label).trim() || `#${ann.id}`;
    }

    refreshAnnotationAttributeDisplay() {
        if (this._annotationAttributeDisplayRaf) {
            cancelAnimationFrame(this._annotationAttributeDisplayRaf);
        }
        this._annotationAttributeDisplayRaf = requestAnimationFrame(() => {
            this._annotationAttributeDisplayRaf = null;
            this.renderAnnotationBoxes();
            this.renderMapLegend();
            this.updateAttributesHeaderLabel();
        });
    }

    refreshBusinessCategoryDisplay() {
        this.refreshAnnotationAttributeDisplay();
    }

    getAnnotationLabelOptions(ann) {
        if (!ann || ann.type !== 'bbox') return [];

        const groupName = typeof ann.attribute === 'string' ? ann.attribute.trim() : '';
        const values = Array.isArray(this.configuredLabelGroups[groupName])
            ? [...this.configuredLabelGroups[groupName]]
            : [];

        if (ann.label && !values.includes(ann.label)) {
            values.unshift(ann.label);
        }

        return values;
    }

    buildAnnotationLabelField(ann, options) {
        const field = document.createElement('div');
        field.className = 'attr-field';

        const lbl = this.buildAttrFieldLabel('Label / Type');
        const sel = document.createElement('select');
        this.populateSelectOptions(sel, options, ann.label || '');

        const handleLabelChange = () => {
            const nextValue = sel.value;
            const lastValue = sel.dataset.attrLastValue || '';
            if (nextValue === lastValue) return;

            this.pushHistory();
            ann.label = nextValue;
            ann.level = this.getLevelForGroup(ann.attribute);
            sel.dataset.attrLastValue = nextValue;
            this.hasUnsavedChanges = true;
            this.refreshAnnotationAttributeDisplay();
        };

        sel.addEventListener('input', handleLabelChange);
        sel.addEventListener('change', handleLabelChange);

        field.appendChild(lbl);
        field.appendChild(sel);
        return field;
    }

    populateSelectOptions(selectEl, options, selectedValue) {
        if (!selectEl) return;
        selectEl.textContent = '';
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '—';
        selectEl.appendChild(emptyOpt);

        const values = Array.isArray(options) ? [...options] : [];
        if (selectedValue && !values.includes(selectedValue)) {
            values.unshift(selectedValue);
        }

        for (const opt of values) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = this.getDisplayText(opt).trim() || '—';
            if (selectedValue === opt) o.selected = true;
            selectEl.appendChild(o);
        }

        selectEl.value = selectedValue && values.includes(selectedValue) ? selectedValue : '';
        selectEl.dataset.attrLastValue = selectEl.value;
    }

    appendBusinessCategoryFields(content, attrs, ann, onAfterChange) {
        const categoryOptions = this.getCategoryLabels();
        if (categoryOptions.length === 0) return false;

        const handleAfterChange = (value) => {
            this.refreshBusinessCategoryDisplay();
            if (onAfterChange) onAfterChange(value);
        };

        let subcategoryField = null;
        const categoryField = this.buildAttrSelect(
            'category',
            'Category',
            categoryOptions,
            attrs,
            ann,
            (value) => {
                const subcategoryOptions = this.getBusinessSubcategoryOptions(value);
                const selectedSubcategories = this.normalizeSubcategoryValues(attrs.subcategory)
                    .filter(item => subcategoryOptions.includes(item));
                attrs.subcategory = selectedSubcategories;
                if (subcategoryField) {
                    this.populateMultiSelectOptions(
                        subcategoryField,
                        subcategoryOptions,
                        selectedSubcategories,
                        attrs,
                        'subcategory',
                        ann,
                        handleAfterChange,
                        {
                            searchable: true,
                            searchPlaceholder: this.englishOnly ? 'Search sub-category…' : '搜索 Sub-category…',
                        }
                    );
                }
                handleAfterChange(value);
            },
            {
                searchable: true,
                searchPlaceholder: this.englishOnly ? 'Search category…' : '搜索 Category…',
            }
        );
        content.appendChild(categoryField);

        const subcategoryOptions = this.getBusinessSubcategoryOptions(attrs.category);
        subcategoryField = this.buildAttrMultiSelect(
            'subcategory',
            'Sub-category',
            subcategoryOptions,
            attrs,
            ann,
            handleAfterChange,
            {
                searchable: true,
                searchPlaceholder: this.englishOnly ? 'Search sub-category…' : '搜索 Sub-category…',
                helpUrl: this.getTranslationTableUrl(),
                helpTitle: 'Open Sub-category translation table',
            }
        );
        content.appendChild(subcategoryField);
        return true;
    }

    buildAttrFieldLabel(labelText, labelOptions = {}) {
        const lbl = document.createElement('label');
        lbl.className = 'attr-field-label';

        const text = document.createElement('span');
        text.textContent = labelText;
        lbl.appendChild(text);

        if (labelOptions.helpUrl) {
            const helpLink = document.createElement('a');
            helpLink.className = 'attr-help-link';
            helpLink.href = labelOptions.helpUrl;
            helpLink.target = '_blank';
            helpLink.rel = 'noopener noreferrer';
            helpLink.title = labelOptions.helpTitle || 'Open help';
            helpLink.textContent = '?';
            helpLink.addEventListener('click', (event) => event.stopPropagation());
            lbl.appendChild(helpLink);
        }

        return lbl;
    }

    buildAttrInput(key, labelText, inputType, attrs, ann, onAfterChange) {
        const field = document.createElement('div');
        field.className = 'attr-field';
        const lbl = this.buildAttrFieldLabel(labelText);
        const inp = document.createElement('input');
        inp.type = inputType === 'aisle' ? 'text' : inputType;
        inp.value = attrs[key] != null ? attrs[key] : '';
        if (inputType === 'number') { inp.min = '0'; inp.step = '1'; inp.style.width = '60px'; }
        if (inputType === 'aisle') {
            inp.placeholder = this.englishOnly ? 'Numbers / letters' : '数字/字母';
            inp.style.width = '80px';
            inp.style.textTransform = 'uppercase';
            inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^0-9A-Z]/g, ''); });
        }
        inp.addEventListener('change', () => {
            this.pushHistory();
            attrs[key] = inputType === 'number' ? (parseFloat(inp.value) || 0) : inp.value;
            this.hasUnsavedChanges = true;
            if (onAfterChange) onAfterChange();
        });
        field.appendChild(lbl);
        field.appendChild(inp);
        return field;
    }

    buildAttrRow(...classNames) {
        const row = document.createElement('div');
        row.className = ['attr-row', ...classNames.filter(Boolean)].join(' ');
        return row;
    }

    populateMultiSelectOptions(field, options, selectedValues, attrs, key, ann, onAfterChange, fieldOptions = {}) {
        if (!field) return;
        const list = field.querySelector('.attr-multiselect-options');
        if (!list) return;

        const normalizedSelected = this.normalizeSubcategoryValues(selectedValues);
        field._attrAllOptions = Array.isArray(options) ? [...options] : [];

        const searchInput = field.querySelector('.attr-search-input');
        const searchQuery = field.dataset.attrSearchValue || (searchInput ? searchInput.value : '');
        const values = this.filterOptionsBySearch(field._attrAllOptions, searchQuery, normalizedSelected);

        list.textContent = '';

        if (values.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'attr-multiselect-empty';
            empty.textContent = searchQuery ? 'No matches' : '—';
            list.appendChild(empty);
            field.dataset.attrLastValue = JSON.stringify([]);
            return;
        }

        for (const opt of values) {
            const item = document.createElement('label');
            item.className = 'attr-multiselect-option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = opt;
            checkbox.checked = normalizedSelected.includes(opt);

            const text = document.createElement('span');
            text.textContent = this.getDisplayText(opt).trim() || '—';

            checkbox.addEventListener('change', () => {
                const nextValues = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
                    .map(input => input.value);
                const nextSerialized = JSON.stringify(nextValues);
                const lastSerialized = field.dataset.attrLastValue || '[]';
                if (nextSerialized === lastSerialized) return;
                this.pushHistory();
                attrs[key] = nextValues;
                field.dataset.attrLastValue = nextSerialized;
                this.hasUnsavedChanges = true;
                if (onAfterChange) onAfterChange(nextValues);
            });

            item.appendChild(checkbox);
            item.appendChild(text);
            list.appendChild(item);
        }

        field.dataset.attrLastValue = JSON.stringify(normalizedSelected);
    }

    buildAttrMultiSelect(key, labelText, options, attrs, ann, onAfterChange, labelOptions = {}) {
        const field = document.createElement('div');
        field.className = 'attr-field attr-field--multiselect';

        const lbl = this.buildAttrFieldLabel(labelText, labelOptions);
        field.appendChild(lbl);

        if (labelOptions.searchable) {
            field.classList.add('attr-field--searchable');
            const searchInput = document.createElement('input');
            searchInput.type = 'search';
            searchInput.className = 'attr-search-input';
            searchInput.placeholder = labelOptions.searchPlaceholder || 'Search…';
            searchInput.autocomplete = 'off';
            searchInput.spellcheck = false;
            searchInput.addEventListener('input', () => {
                field.dataset.attrSearchValue = searchInput.value;
                this.populateMultiSelectOptions(
                    field,
                    field._attrAllOptions || [],
                    attrs[key],
                    attrs,
                    key,
                    ann,
                    onAfterChange,
                    labelOptions
                );
            });
            field.appendChild(searchInput);
        }

        const list = document.createElement('div');
        list.className = 'attr-multiselect-options';
        field.appendChild(list);

        this.populateMultiSelectOptions(field, options, attrs[key], attrs, key, ann, onAfterChange, labelOptions);
        return field;
    }

    buildAttrSelect(key, labelText, options, attrs, ann, onAfterChange, fieldOptions = {}) {
        const field = document.createElement('div');
        field.className = 'attr-field';
        const lbl = this.buildAttrFieldLabel(labelText, fieldOptions);
        const sel = document.createElement('select');
        const selectedValue = attrs[key] != null ? attrs[key] : '';
        field._attrAllOptions = Array.isArray(options) ? [...options] : [];

        const refreshSelectOptions = () => {
            const searchQuery = field.dataset.attrSearchValue || '';
            const filteredOptions = fieldOptions.searchable
                ? this.filterOptionsBySearch(field._attrAllOptions, searchQuery, [attrs[key] != null ? attrs[key] : selectedValue])
                : field._attrAllOptions;
            this.populateSelectOptions(sel, filteredOptions, attrs[key] != null ? attrs[key] : selectedValue);
        };

        if (fieldOptions.searchable) {
            field.classList.add('attr-field--searchable');
            const searchInput = document.createElement('input');
            searchInput.type = 'search';
            searchInput.className = 'attr-search-input';
            searchInput.placeholder = fieldOptions.searchPlaceholder || 'Search…';
            searchInput.autocomplete = 'off';
            searchInput.spellcheck = false;
            searchInput.addEventListener('input', () => {
                field.dataset.attrSearchValue = searchInput.value;
                refreshSelectOptions();
            });
            field.appendChild(lbl);
            field.appendChild(searchInput);
            field.appendChild(sel);
        } else {
            field.appendChild(lbl);
            field.appendChild(sel);
        }

        refreshSelectOptions();
        const handleSelectValueChange = () => {
            const nextValue = sel.value;
            const lastValue = sel.dataset.attrLastValue || '';
            if (nextValue === lastValue) return;
            this.pushHistory();
            attrs[key] = nextValue;
            sel.dataset.attrLastValue = nextValue;
            this.hasUnsavedChanges = true;
            if (onAfterChange) onAfterChange(nextValue);
        };
        sel.addEventListener('input', handleSelectValueChange);
        sel.addEventListener('change', handleSelectValueChange);
        return field;
    }

    // Auto-number for Shelf labels
    getNextShelfNumber() {
        let max = 0;
        for (const a of this.annotations) {
            if ((a.label === 'Shelf' || a.label === 'Wall shelf') && a.attributes && a.attributes.shelfNumber != null) {
                const n = parseInt(a.attributes.shelfNumber, 10);
                if (!isNaN(n)) max = Math.max(max, n);
            }
        }
        return max + 1;
    }

    // ========================================================================
    // Boundary check (warn if annotation outside Boundary polygon)
    // ========================================================================

    checkBoundaryConstraint(ann) {
        const boundary = this.annotations.find(a => a.type === 'polygon' && a.label === 'Boundary');
        if (!boundary || !Array.isArray(boundary.vertices)) return true; // no boundary defined
        if (ann.type === 'polygon') {
            if (!ann.vertices) return true;
            // All vertices must be inside boundary
            return ann.vertices.every(v => this.pointInPolygon(v[0], v[1], boundary.vertices));
        } else {
            // BBox: check all four corners
            const corners = [
                [ann.x, ann.y], [ann.x + ann.width, ann.y],
                [ann.x, ann.y + ann.height], [ann.x + ann.width, ann.y + ann.height]
            ];
            return corners.every(c => this.pointInPolygon(c[0], c[1], boundary.vertices));
        }
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
        assetsUrl: window.LAYOUT_ASSETS_URL || '',
        labelsYamlUrl: window.LAYOUT_LABELS_YAML_URL || 'labels.yaml',
        businessCategoryYamlUrl: window.LAYOUT_BUSINESS_L1_L2_YAML_URL || 'business_l1_l2.yaml',
    });
});
