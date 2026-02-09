let overlayHls = null;
const NEWEST_ELEMENT = document.getElementById('newest');

const BUFFER_END_OF_STREAM_RECOVERY_THROTTLE_MS = 2000;
const END_OF_VIDEO_THRESHOLD_SECONDS = 0.5;
const OVERLAY_POST_PLAY_BUFFER_LENGTH = 180;
const OVERLAY_POST_PLAY_MAX_BUFFER_LENGTH = 360;
const OVERLAY_POST_PLAY_BUFFER_SIZE = 200 * 1000 * 1000;
const OVERLAY_POST_PLAY_BACK_BUFFER = 120;
const DEFAULT_RESOLUTION = '480p';

/**
 * Shared HLS.js configuration optimized for on-demand transcoding scenarios.
 * Includes extended timeouts, aggressive retry logic, and buffer management.
 * @returns {Object} HLS.js configuration object
 */
function getHlsConfig() {
    return {
        xhrSetup: function (xhr) {
            xhr.withCredentials = true;
        },

        // BUFFER-MANAGEMENT - Extended for transcoding delays
        maxBufferLength: 60,
        maxMaxBufferLength: 1200,
        maxBufferSize: 120 * 1000 * 1000,
        maxBufferHole: 1.0,
        backBufferLength: 120,

        // STALL-DETECTION - More tolerant for transcoding
        lowBufferWatchdogPeriod: 1.0,
        highBufferWatchdogPeriod: 3,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 5,
        maxFragLookUpTolerance: 0.5,

        // PERFORMANCE
        enableWorker: true,
        startFragPrefetch: true,
        testBandwidth: true,
        enableSoftwareAES: true,

        // SEEK - More tolerant
        maxSeekHole: 3,
        seekHoleNudgeDuration: 0.02,

        // NETWORK-CONFIGURATION - Extended for transcoding
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 2000,
        manifestLoadingMaxRetryTimeout: 64000,
        levelLoadingTimeOut: 30000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 2000,
        levelLoadingMaxRetryTimeout: 64000,
        fragLoadingTimeOut: 60000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 2000,
        fragLoadingMaxRetryTimeout: 64000,

        // APPEND-CONFIGURATION - More retries
        appendErrorMaxRetry: 5,

        // ADVANCED SETTINGS
        lowLatencyMode: false,
        enableCEA708Captions: false,
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,

        // LIVE-STREAM-CONFIGURATION
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: false,

        // FRAGMENT-DRIFT-TOLERANCE - More tolerant
        maxAudioFramesDrift: 2,
        maxVideoFramesDrift: 2,

        // START-POSITION
        startPosition: -1,

        // DEBUG
        debug: false,

        // METADATA-CONFIGURATION
        enableDateRangeMetadataCues: false,
        enableEmsgMetadataCues: false,
        enableID3MetadataCues: false
    };
}

/**
 * HLS.js configuration specifically for overlay player optimized for on-demand transcoding.
 * Configured to prevent segment skipping and wait patiently for transcoding to complete.
 * @returns {Object} HLS.js configuration object
 */
function getOverlayHlsConfig() {
    return {
        xhrSetup: function (xhr) {
            xhr.withCredentials = true;
        },
        autoStartLoad: false, // Manual startLoad to control load timing in the overlay.

        // BUFFER-MANAGEMENT - Allow progressive buffering as segments become available
        maxBufferLength: 30, // Reduce to prevent aggressive prefetching
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.1, // Very small - don't skip gaps
        backBufferLength: 20,

        // STALL-DETECTION - Disabled to prevent auto-skip behavior
        lowBufferWatchdogPeriod: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.05,
        nudgeMaxRetry: 0, // Disable auto-nudge - CRITICAL
        maxFragLookUpTolerance: 0.05, // Very strict

        // PERFORMANCE
        enableWorker: true,
        startFragPrefetch: false, // Critical: don't prefetch
        testBandwidth: false,
        enableSoftwareAES: true,
        progressive: false, // Disable progressive loading to prevent parallel requests
        
        // ABR - Disable adaptive bitrate to prevent segment jumping
        abrEwmaFastLive: 1,
        abrEwmaSlowLive: 3,
        abrEwmaFastVoD: 1,
        abrEwmaSlowVoD: 3,
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.7,

        // SEEK - Very strict to prevent skipping
        maxSeekHole: 0.05,
        seekHoleNudgeDuration: 0.01,

        // NETWORK-CONFIGURATION - Managed by custom retry logic
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 2000,
        manifestLoadingMaxRetryTimeout: 60000,
        levelLoadingTimeOut: 30000,
        levelLoadingMaxRetry: 3,
        levelLoadingRetryDelay: 2000,
        levelLoadingMaxRetryTimeout: 60000,
        
        // FRAGMENT-LOADING - Let our custom handler manage this
        fragLoadingTimeOut: 30000, // 30 seconds timeout
        fragLoadingMaxRetry: 1, // We handle retries manually
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryTimeout: 30000,

        // APPEND-CONFIGURATION
        appendErrorMaxRetry: 3,

        // ADVANCED SETTINGS
        lowLatencyMode: false,
        enableCEA708Captions: false,
        stretchShortVideoTrack: false, // Don't manipulate playback
        forceKeyFrameOnDiscontinuity: false,
        abrEwmaDefaultEstimate: 500000,
        
        // LIVE-STREAM-CONFIGURATION
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 5,
        liveDurationInfinity: false,

        // FRAGMENT-DRIFT-TOLERANCE - Strict to prevent skipping
        maxAudioFramesDrift: 1,
        maxVideoFramesDrift: 1,

        // START-POSITION
        startPosition: -1,

        // DEBUG
        debug: false,

        // METADATA-CONFIGURATION
        enableDateRangeMetadataCues: false,
        enableEmsgMetadataCues: false,
        enableID3MetadataCues: false
    };
}

/**
 * Creates a custom HLS loader that retries fragment requests returning HTTP 202
 * until the segment becomes available.
 * @param {number} retryDelay - Delay between retry attempts in ms.
 * @returns {Function} Custom loader class for HLS.js.
 */
function createOverlaySegmentLoader(retryDelay = 1500) {
    const BaseLoader = Hls.DefaultConfig.loader;

    return class OverlaySegmentLoader extends BaseLoader {
        constructor(config) {
            super(config);
            this.retryDelay = retryDelay;
            this.retryTimer = null;
            this.isDestroyed = false;
        }

        load(context, config, callbacks) {
            const wrappedCallbacks = {
                onSuccess: (response, stats, ctx, networkDetails) => {
                    if (ctx?.type === 'fragment' && stats?.httpStatus === 202) {
                        if (this.retryTimer) {
                            clearTimeout(this.retryTimer);
                        }
                        this.retryTimer = setTimeout(() => {
                            if (!this.isDestroyed) {
                                super.load(context, config, wrappedCallbacks);
                            }
                        }, this.retryDelay);
                        return;
                    }
                    callbacks.onSuccess(response, stats, ctx, networkDetails);
                },
                onError: (error, ctx, networkDetails) => {
                    callbacks.onError(error, ctx, networkDetails);
                },
                onTimeout: (stats, ctx, networkDetails) => {
                    callbacks.onTimeout(stats, ctx, networkDetails);
                },
                onProgress: (stats, ctx, data, networkDetails) => {
                    if (callbacks.onProgress) {
                        callbacks.onProgress(stats, ctx, data, networkDetails);
                    }
                }
            };

            super.load(context, config, wrappedCallbacks);
        }

        abort() {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
            super.abort();
        }

        destroy() {
            this.isDestroyed = true;
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
            super.destroy();
        }
    };
}

/**
 * Attempts to play video with retry logic for transcoding delays.
 * @param {HTMLVideoElement} videoElement - The video element to play.
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} retryDelay - Delay between retries in ms.
 * @returns {Promise<void>}
 */
async function attemptPlayback(videoElement, maxRetries = 10, retryDelay = 500) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (videoElement.readyState >= 2) {
                await videoElement.play();
                return;
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        } catch (error) {
            if (attempt === maxRetries - 1) {
                console.log("Playback requires user interaction or failed after retries");
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

/**
 * Attempts to recover playback when buffer reports end-of-stream before actual media end.
 * @param {Hls} hlsInstance - The HLS.js instance.
 * @param {HTMLVideoElement} videoElement - The video element to resume.
 * @param {{last: number}} recoveryState - Tracks last recovery timestamp (Date.now()).
 */
function recoverFromBufferEOS(hlsInstance, videoElement, recoveryState) {
    const now = Date.now();
    if (recoveryState.last > 0 &&
        now - recoveryState.last < BUFFER_END_OF_STREAM_RECOVERY_THROTTLE_MS) {
        return;
    }
    if (videoElement.ended) {
        return;
    }
    if (Number.isFinite(videoElement.duration) &&
        videoElement.currentTime >= videoElement.duration - END_OF_VIDEO_THRESHOLD_SECONDS) {
        return;
    }
    if (!hlsInstance || !hlsInstance.media) {
        return;
    }
    // Restart loading from the current position and attempt to resume playback.
    recoveryState.last = now;
    try {
        hlsInstance.startLoad(videoElement.currentTime);
        attemptPlayback(videoElement);
    } catch (error) {
        console.warn('Failed to recover from buffer EOS.', error);
    }
}

/**
 * Sets up common HLS error handling with recovery logic.
 * @param {Hls} hlsInstance - The HLS.js instance.
 * @param {HTMLVideoElement} videoElement - The associated video element.
 * @param {Function} reloadCallback - Callback to reload the video on fatal error.
 */
function setupHlsErrorHandling(hlsInstance, videoElement, reloadCallback) {
    let recoverAttempts = 0;
    const maxRecoverAttempts = 3;
    const eosRecoveryState = { last: 0 };

    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
            console.warn("HLS fatal error:", data.type, data.details);

            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log("Network error, attempting recovery...");
                    if (recoverAttempts < maxRecoverAttempts) {
                        recoverAttempts++;
                        setTimeout(() => {
                            hlsInstance.startLoad();
                        }, 2000 * recoverAttempts);
                    } else if (reloadCallback) {
                        console.log("Max recovery attempts reached, reloading...");
                        recoverAttempts = 0;
                        setTimeout(reloadCallback, 3000);
                    }
                    break;

                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log("Media error, attempting recovery...");
                    if (recoverAttempts < maxRecoverAttempts) {
                        recoverAttempts++;
                        hlsInstance.recoverMediaError();
                    } else {
                        console.log("Trying swap audio codec recovery...");
                        hlsInstance.swapAudioCodec();
                        hlsInstance.recoverMediaError();
                        recoverAttempts = 0;
                    }
                    break;

                default:
                    console.error("Unrecoverable HLS error:", data);
                    break;
            }
        } else {
            // Non-fatal errors - log but continue
            if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
                console.log("Buffer stalled, waiting for more data...");
            } else if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
                console.log("Fragment load error, will retry automatically...");
            }
        }
    });

    // Handle buffer stalls gracefully
    hlsInstance.on(Hls.Events.BUFFER_EOS, () => {
        console.log("Buffer end of stream reached");
        recoverFromBufferEOS(hlsInstance, videoElement, eosRecoveryState);
    });

    // Reset recovery counter on successful playback
    videoElement.addEventListener('playing', () => {
        recoverAttempts = 0;
    });
}

/**
 * Scrolls a video list container horizontally.
 * @param {HTMLElement} button - The button that triggered the scroll.
 * @param {number} amount - The number of pixels to scroll.
 */
function scrollHorizontally(button, amount) {
    const wrapper = button.closest('.scroll-wrapper');
    const container = wrapper.querySelector('ul');

    container.scrollBy({
        left: amount, behavior: 'smooth'
    });
}

/**
 * Initializes the video list and UI elements on page load.
 */
async function initVideoList() {
    initDOMElements();
    initEventListeners();
    setHeader();
    startRefreshIntervall();
    await loadAndSetupVideos();
    initScrollIndicators();
}

/**
 * Initializes key DOM elements used for video playback.
 */
function initDOMElements() {
    videoContainer = document.getElementById('videoPlayer');
    overlayVideoContainer = document.getElementById('overlayVideo');
    LASTREFRESH = new Date().getTime();
}

/**
 * Sets up event listeners such as resolution change.
 */
function initEventListeners() {
    const resolutionSelect = document.getElementById('setResolution');
    if (resolutionSelect) {
        resolutionSelect.addEventListener('change', handleResolutionChange);
    }
}

/**
 * Handles video resolution changes from the dropdown.
 * @param {Event} event - The change event.
 */
function handleResolutionChange(event) {
    currentResolution = event.target.value;
    if (currentVideo && document.getElementById('overlay').style.display === 'flex') {
        const resumeTime = overlayVideoContainer ? overlayVideoContainer.currentTime : 0;
        const resumePlayback = overlayVideoContainer ? !overlayVideoContainer.paused : true;
        loadVideoInOverlay(currentVideo, currentResolution, {
            startTime: resumeTime,
            resumePlayback
        });
    }
}

/**
 * Loads videos from the backend and sets up the UI.
 */
async function loadAndSetupVideos() {
    let response
    try {
        response = await getData();
        VIDEOS = await response.json();
        await getNewestVideos();
        setStartVideo();
        await renderVideosDynamically();
        setupInitialVideo();
    } catch (error) {
        document.getElementById('videoTitle').style.color = 'red';
        document.getElementById('category-new').style.display = 'none';
        document.getElementById('playButton').style.display = 'none';
        showToastMessage(true, ['Failed to load videos']);
    }
}

/**
 * Sets the initial video on page load.
 */
function setupInitialVideo() {
    if (VIDEOS && VIDEOS.length > 0) {
        currentVideo = VIDEOS[0].id;
        loadVideo(VIDEOS[0].id, '480p');
    }
}

/**
 * Filters the most recent videos (within the last 5 days).
 */
async function getNewestVideos() {
    let currentDate = new Date();
    let timeSpan = new Date(currentDate.getTime() - (5 * 24 * 60 * 60 * 1000));
    VIDEOS.forEach(video => {
        const videoDate = new Date(video.created_at)
        if (videoDate >= timeSpan) {
            LATESTVIDEOS.push(video)
        }
    })
}

/**
 * Sets the title and description for the first video.
 */
function setStartVideo() {
    document.getElementById('videoTitle').innerHTML = VIDEOS[0].title;
    document.getElementById('videoDescription').innerHTML = VIDEOS[0].description;
}

/**
 * Dynamically renders all video sections: first the "Newest" section, then all other categories.
 * It collects unique categories from the VIDEOS array, removes existing dynamic sections,
 * and creates new sections grouped by category.
 *
 * @async
 * @function
 */
async function renderVideosDynamically() {
    const container = document.querySelector('.list_section');

    renderNewestSection();

    const categories = new Set(VIDEOS.map(v => v.category.toLowerCase()));
    clearDynamicSections(container);

    categories.forEach(cat => {
        if (cat === 'newest') return;
        const videosInCategory = VIDEOS.filter(v => v.category.toLowerCase() === cat);
        const section = renderCategorySection(cat, videosInCategory);
        container.appendChild(section);
    });
}

/**
 * Renders the "Newest" video section.
 * Clears the existing content and appends each video from LATESTVIDEOS
 * using the `videoTemplate` function.
 *
 * @function
 */
function renderNewestSection() {
    NEWEST_ELEMENT.innerHTML = '';
    LATESTVIDEOS.forEach(video => {
        NEWEST_ELEMENT.append(videoTemplate(video, video.thumbnail_url));
    });
}

/**
 * Removes all dynamically generated category sections from the given container.
 *
 * @param {HTMLElement} container - The parent element containing video sections.
 *
 * @function
 */
function clearDynamicSections(container) {
    [...container.querySelectorAll('.video_list.dynamic-category')].forEach(el => el.remove());
}

/**
 * Creates a section element for a specific video category, including a heading and video list.
 *
 * @param {string} cat - The category name (in lowercase).
 * @param {Object[]} videos - An array of video objects belonging to this category.
 * @returns {HTMLElement} - The constructed <section> DOM element.
 *
 * @function
 */
function renderCategorySection(cat, videos) {
    const section = document.createElement('section');
    section.classList.add('video_list', 'dynamic-category');

    const h2 = document.createElement('h2');
    h2.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    section.appendChild(h2);

    const scrollWrapper = document.createElement('div');
    scrollWrapper.classList.add('scroll-wrapper');

    const ul = document.createElement('ul');
    ul.id = cat;

    videos.forEach(video => {
        ul.appendChild(videoTemplate(video));
    });

    scrollWrapper.appendChild(ul);
    section.appendChild(scrollWrapper);

    return section;
}

/**
 * Creates a video thumbnail element.
 * @param {Object} video - The video object.
 * @returns {HTMLElement} The list item containing the video thumbnail.
 */
function videoTemplate(video) {
    let listItem = document.createElement('li');
    let img = document.createElement('img');
    img.setAttribute("src", video.thumbnail_url || '')
    img.setAttribute("alt", video.title || '')
    img.setAttribute("onclick", `showVideo(${video.id})`)
    listItem.append(img);
    return listItem;
}

/**
 * Displays video details and loads the selected video.
 * @param {number} id - The video ID.
 */
function showVideo(id) {
    let video = VIDEOS.find(video => video.id == id);
    document.getElementById('videoTitle').innerHTML = video.title;
    document.getElementById('videoDescription').innerHTML = video.description;
    document.getElementById('playButton').setAttribute("onclick", `playVideo(${id})`)
    currentVideo = id
    loadVideo(id, '480p');
}

/**
 * Starts an interval that refreshes the JWT token every 20 minutes.
 */
function startRefreshIntervall() {
    STARTINTERVALL = setInterval(async () => {
        await doRefresh();
    }, 20 * 60 * 1000);
}

/**
 * Calls the backend to refresh the JWT token.
 */
async function doRefresh() {
    await fetch(`${API_BASE_URL}${REFRESH_URL}`, {
        method: 'POST', headers: {
            'Content-Type': 'application/json',
        }, credentials: 'include',
    })
}

/**
 * Loads and plays a video using HLS.js with robust transcoding support.
 * @param {number} id - The video ID.
 * @param {string} resolution - The desired video resolution (e.g., '480p').
 */
function loadVideo(id, resolution) {
    if (hls) {
        hls.destroy();
    }

    hls = new Hls(getHlsConfig());

    const videoUrl = `${API_BASE_URL}${URL_TO_PREVIEW_M3U8(id, resolution)}`;
    hls.loadSource(videoUrl);
    hls.attachMedia(videoContainer);

    // Setup error handling with reload callback
    setupHlsErrorHandling(hls, videoContainer, () => {
        loadVideo(id, resolution);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Wait for sufficient buffer before attempting playback
        const checkBuffer = () => {
            if (videoContainer.readyState >= 3 || hls.media?.buffered?.length > 0) {
                attemptPlayback(videoContainer);
            } else {
                setTimeout(checkBuffer, 500);
            }
        };
        setTimeout(checkBuffer, 1000);
    });

    // Handle level switching for quality adaptation
    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        console.log("Quality level switched to:", data.level);
    });
}

/**
 * Proofs if a container is scrollable and add then the CSS class
 * @param {HTMLElement} container - container that should be proofed
 */
function updateScrollIndicator(container) {
    const scrollWrapper = container.closest('.scroll-wrapper');
    if (!scrollWrapper) return;

    const isScrollable = container.scrollWidth > container.clientWidth;

    if (isScrollable) {
        scrollWrapper.classList.add('scrollable');
    } else {
        scrollWrapper.classList.remove('scrollable');
    }
}

/**
 * Initialised scroll indicators for all video lists
 */
function initScrollIndicators() {
    const videoLists = document.querySelectorAll('.video_list ul');

    videoLists.forEach(list => {
        updateScrollIndicator(list);

        if (window.ResizeObserver) {
            const resizeObserver = new ResizeObserver(() => {
                updateScrollIndicator(list);
            });
            resizeObserver.observe(list);
            resizeObserver.observe(list.parentElement);
        }

        window.addEventListener('resize', () => {
            setTimeout(() => updateScrollIndicator(list), 100);
        });
    });
}

/**
 * Loads a video in the overlay using HLS.js optimized for on-demand transcoding.
 * Ensures fragment loading waits for 202 responses and preserves playback state across quality changes.
 * @param {number} id - The video ID.
 * @param {string} resolution - The desired resolution.
 * @param {{startTime?: number, resumePlayback?: boolean}} [options] - Playback options.
 */
function loadVideoInOverlay(id, resolution, options = {}) {
    const { startTime = 0, resumePlayback = true } = options;

    if (overlayHls) {
        overlayHls.destroy();
    }

    const overlayConfig = getOverlayHlsConfig();
    overlayConfig.loader = createOverlaySegmentLoader();
    overlayHls = new Hls(overlayConfig);

    const videoUrl = `${API_BASE_URL}${URL_TO_INDEX_M3U8(id, resolution)}`;
    overlayHls.loadSource(videoUrl);
    overlayHls.attachMedia(overlayVideoContainer);

    const SEEK_SEGMENT_THRESHOLD = 10; // Backend cancels transcoding beyond 10 segments.
    const SEEK_LOAD_DELAY = 300; // Allow backend to switch transcoding position for seeks and sequential enforcement.
    const INITIAL_SEEK_SETTLE_TIME = 2000;
    const SEEK_BUFFER_POLL_INTERVAL = 500;
    const SEEK_BUFFER_POLL_TIMEOUT = 120000; // Allow ~2 minutes for slow transcoding before resuming.
    const safeStartTime = Number.isFinite(startTime) ? startTime : 0;
    const shouldAutoPlay = resumePlayback;
    let lastLoadedFrag = null;
    let pendingSeekTime = null;
    let resumeAfterSeek = false;
    let controlsLocked = false;
    let ignoreSeekEvent = false;
    let ignoreSeekResetTimer = null;
    let seekBufferTimer = null;
    let seekedHandler = null;
    let userPaused = false;
    let programmaticPause = false;
    let programmaticPlay = false;
    let lastEnforcedSn = null;
    const overlayEosRecoveryState = { last: 0 };
    let postStartBufferingEnabled = false;

    const resolutionSelect = document.getElementById('setResolution');

    function findLevelByResolution(levels, resolutionLabel) {
        if (!levels || !resolutionLabel) {
            return -1;
        }
        return levels.findIndex(level => typeof level?.height === 'number' && resolutionLabel === `${level.height}p`);
    }

    function setControlsLocked(locked) {
        controlsLocked = locked;
        overlayVideoContainer.controls = !locked;
        overlayVideoContainer.style.pointerEvents = locked ? 'none' : '';
        if (resolutionSelect) {
            resolutionSelect.disabled = locked;
        }
    }

    function getLevelDetails() {
        const level = overlayHls?.levels?.[overlayHls.currentLevel];
        return level?.details || null;
    }

    function getFragmentForTime(time) {
        const details = getLevelDetails();
        if (!details?.fragments?.length) {
            return null;
        }
        return details.fragments.find(frag => fragCoversTime(frag, time)) || null;
    }

    function getSegmentDistance(targetFrag, seekTime) {
        if (lastLoadedFrag && targetFrag) {
            return Math.abs(targetFrag.sn - lastLoadedFrag.sn);
        }
        if (!lastLoadedFrag && targetFrag?.sn !== undefined) {
            return Math.abs(targetFrag.sn);
        }
        if (!lastLoadedFrag) {
            return 0;
        }
        const details = getLevelDetails();
        const estimatedSegmentDuration = details?.targetDuration || details?.targetduration || lastLoadedFrag?.duration || targetFrag?.duration; // Support Hls.js target duration naming.
        if (!estimatedSegmentDuration) {
            console.warn('Segment duration unavailable for seek distance.');
            return 0;
        }
        return Math.abs(seekTime - lastLoadedFrag.start) / estimatedSegmentDuration;
    }

    function fragCoversTime(frag, time) {
        return time >= frag.start && time < frag.start + frag.duration;
    }

    function isTimeBuffered(time) {
        if (!overlayVideoContainer.buffered) {
            return false;
        }
        for (let i = 0; i < overlayVideoContainer.buffered.length; i++) {
            if (time >= overlayVideoContainer.buffered.start(i) && time < overlayVideoContainer.buffered.end(i)) {
                return true;
            }
        }
        return false;
    }

    // Returns true when a pending seek is buffered and state updates were applied; false otherwise.
    function tryResumeFromSeek() {
        const buffered = pendingSeekTime !== null && isTimeBuffered(pendingSeekTime);
        if (!buffered) {
            return false;
        }
        pendingSeekTime = null;
        setControlsLocked(false);
        if (resumeAfterSeek) {
            programmaticPlay = true;
            attemptPlayback(overlayVideoContainer);
        }
        resumeAfterSeek = false;
        // True indicates the buffered seek was handled and state was updated.
        return buffered;
    }

    function isOutOfOrderFragment(frag) {
        // Only enforce strict ordering during normal playback; seeks are handled separately.
        return pendingSeekTime === null
            && lastLoadedFrag
            && Number.isFinite(lastLoadedFrag.sn)
            && Number.isFinite(frag.sn)
            && frag.sn > lastLoadedFrag.sn + 1;
    }

    function enforceSequentialLoad(frag) {
        if (!isOutOfOrderFragment(frag)) {
            return false;
        }
        if (lastEnforcedSn === frag.sn) {
            // Already enforced this fragment; ignore it to avoid repeating load restarts.
            return true;
        }
        if (typeof lastLoadedFrag.start !== 'number' || typeof lastLoadedFrag.duration !== 'number') {
            console.warn('Missing fragment timing; skipping sequential enforcement.');
            return false;
        }
        const expectedTime = lastLoadedFrag.start + lastLoadedFrag.duration;
        if (!Number.isFinite(expectedTime) || expectedTime < 0) {
            console.warn('Invalid fragment timing; skipping sequential enforcement.');
            return false;
        }
        lastEnforcedSn = frag.sn;
        overlayHls.stopLoad();
        setTimeout(() => overlayHls.startLoad(expectedTime), SEEK_LOAD_DELAY);
        return true;
    }

    function shouldResumeAfterSeek() {
        return !userPaused && (resumeAfterSeek || !overlayVideoContainer.paused);
    }

    function clearSeekBufferTimer() {
        if (seekBufferTimer) {
            clearInterval(seekBufferTimer);
            seekBufferTimer = null;
        }
    }

    function clearSeekedHandler() {
        if (seekedHandler) {
            overlayVideoContainer.removeEventListener('seeked', seekedHandler);
            seekedHandler = null;
        }
    }

    function resetSeekTracking() {
        clearSeekBufferTimer();
        clearSeekedHandler();
    }

    function clearSeekState() {
        resetSeekTracking();
        pendingSeekTime = null;
    }

    function shouldResumePlaybackAfterSeek() {
        // Resume if the user hasn't paused playback.
        return !userPaused;
    }

    setControlsLocked(false);
    // Replace handlers on re-init; these are the sole overlay player listeners.
    overlayVideoContainer.onemptied = () => {
        clearSeekState();
    };
    overlayVideoContainer.onplay = () => {
        if (programmaticPlay) {
            programmaticPlay = false;
            return;
        }
        userPaused = false;
        if (pendingSeekTime !== null) {
            resumeAfterSeek = true;
            programmaticPause = true;
            overlayVideoContainer.pause();
        }
    };
    overlayVideoContainer.onpause = () => {
        if (programmaticPause) {
            programmaticPause = false;
            return;
        }
        if (!overlayVideoContainer.seeking
            && pendingSeekTime === null) {
            userPaused = true;
        }
    };
    overlayVideoContainer.onplaying = () => {
        if (postStartBufferingEnabled || !overlayHls) {
            return;
        }
        postStartBufferingEnabled = true;
        // Increase buffer targets after playback starts to reduce rebuffering.
        // Preserve any higher configured values to avoid shrinking buffers mid-session.
        overlayHls.config.maxBufferLength = Math.max(overlayHls.config.maxBufferLength, OVERLAY_POST_PLAY_BUFFER_LENGTH);
        overlayHls.config.maxMaxBufferLength = Math.max(overlayHls.config.maxMaxBufferLength, OVERLAY_POST_PLAY_MAX_BUFFER_LENGTH);
        overlayHls.config.maxBufferSize = Math.max(overlayHls.config.maxBufferSize, OVERLAY_POST_PLAY_BUFFER_SIZE);
        // backBufferLength can be undefined in HLS.js configs, so guard with nullish coalescing.
        overlayHls.config.backBufferLength = Math.max(overlayHls.config.backBufferLength ?? 0, OVERLAY_POST_PLAY_BACK_BUFFER);
    };

    overlayVideoContainer.onseeking = () => {
        if (ignoreSeekEvent) {
            return;
        }

        const seekTime = overlayVideoContainer.currentTime;
        const shouldResume = shouldResumePlaybackAfterSeek();

        // Restart the overlay player for reliable seek handling when transcoding is delayed.
        if (currentVideo) {
            clearSeekState();
            if (overlayHls) {
                overlayHls.destroy();
                overlayHls = null;
            }
            // Restart with the current position and playback intent.
            loadVideoInOverlay(currentVideo, currentResolution, {
                startTime: seekTime,
                resumePlayback: shouldResume
            });
            return;
        }

        // Fallback to in-place seek handling if no current video is tracked.
        if (!overlayHls) {
            return;
        }
        const targetFrag = getFragmentForTime(seekTime);
        const segmentDistance = getSegmentDistance(targetFrag, seekTime);
        const shouldLock = segmentDistance >= SEEK_SEGMENT_THRESHOLD;

        lastEnforcedSn = null;
        pendingSeekTime = seekTime;

        // Pause for all seeks; lock controls only for large jumps that restart transcoding.
        if (shouldLock) {
            setControlsLocked(true);
        }

        // Capture pre-pause state so we can resume once the target segment buffers.
        const wasPlaying = shouldResumeAfterSeek();
        programmaticPause = true;
        overlayVideoContainer.pause();
        resumeAfterSeek = wasPlaying;

        overlayHls.stopLoad();
        resetSeekTracking(); // Ensure only one seeked handler for rapid consecutive seeks.
        seekedHandler = () => {
            clearSeekBufferTimer();
            if (!tryResumeFromSeek() && pendingSeekTime !== null) {
                const pollStart = Date.now();
                seekBufferTimer = setInterval(() => {
                    // pendingSeekTime can be cleared by other buffering events between ticks.
                    if (pendingSeekTime === null) {
                        clearSeekBufferTimer();
                        return;
                    }
                    if (Date.now() - pollStart > SEEK_BUFFER_POLL_TIMEOUT) {
                        clearSeekBufferTimer();
                        return;
                    }
                    if (tryResumeFromSeek()) {
                        clearSeekBufferTimer();
                        return;
                    }
                }, SEEK_BUFFER_POLL_INTERVAL);
            }
        };
        overlayVideoContainer.addEventListener('seeked', seekedHandler, { once: true });
        setTimeout(() => {
            try {
                overlayHls.startLoad(seekTime);
            } catch (error) {
                console.error('Failed to restart overlay load after seek.', { seekTime, error });
            }
        }, SEEK_LOAD_DELAY);
    };

    overlayHls.on(Hls.Events.FRAG_LOADING, (event, data) => {
        const frag = data.frag;
        if (!frag || typeof frag.sn !== 'number') {
            return;
        }
        if (pendingSeekTime !== null) {
            if (fragCoversTime(frag, pendingSeekTime)) {
                return;
            }
            if (frag.start > pendingSeekTime) {
                overlayHls.stopLoad();
                setTimeout(() => overlayHls.startLoad(pendingSeekTime), SEEK_LOAD_DELAY);
            }
            return;
        }
        if (!lastLoadedFrag || typeof lastLoadedFrag.sn !== 'number') {
            return;
        }
        const expectedSn = lastLoadedFrag.sn + 1;
        if (frag.sn > expectedSn) {
            const expectedTime = lastLoadedFrag.start + lastLoadedFrag.duration;
            overlayHls.stopLoad();
            setTimeout(() => overlayHls.startLoad(expectedTime), SEEK_LOAD_DELAY);
        }
    });

    overlayHls.on(Hls.Events.FRAG_LOADED, (event, data) => {
        if (isOutOfOrderFragment(data.frag)) {
            // Keep the last sequential fragment to avoid jumping forward.
            // Sequential enforcement happens when buffering completes.
            return;
        }
        lastLoadedFrag = data.frag;
    });

    overlayHls.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
        if (enforceSequentialLoad(data.frag)) {
            return;
        }
        if (pendingSeekTime !== null
            && Number.isFinite(data.frag.start)
            && data.frag.start > pendingSeekTime) {
            // Ignore fragments beyond the requested seek; we'll retry from the target time instead.
            return;
        }
        lastEnforcedSn = null;
        lastLoadedFrag = data.frag;
        if (pendingSeekTime !== null && fragCoversTime(data.frag, pendingSeekTime)) {
            pendingSeekTime = null;
            setControlsLocked(false);
            if (resumeAfterSeek) {
                programmaticPlay = true;
                attemptPlayback(overlayVideoContainer);
            }
            resumeAfterSeek = false;
        }
    });

    overlayHls.on(Hls.Events.BUFFER_EOS, () => {
        recoverFromBufferEOS(overlayHls, overlayVideoContainer, overlayEosRecoveryState);
    });

    overlayHls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
            console.error('Fatal HLS error in overlay player:', data.type, data.details);
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    overlayHls.stopLoad();
                    setTimeout(() => overlayHls.startLoad(), 2000);
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    overlayHls.recoverMediaError();
                    break;
                default:
                    showPlaybackError('Playback failed due to an unrecoverable error.');
                    break;
            }
        }
    });

    overlayHls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("Manifest parsed, waiting for segments...");
        if (overlayHls.levels && overlayHls.levels.length > 0) {
            // Disable auto quality to avoid switches during on-demand transcoding; users must choose manually.
            overlayHls.autoLevelEnabled = false;
            const preferredResolution = currentResolution || DEFAULT_RESOLUTION;
            const preferredIndex = findLevelByResolution(overlayHls.levels, preferredResolution);
            const defaultIndex = findLevelByResolution(overlayHls.levels, DEFAULT_RESOLUTION);
            const resolvedLevel = preferredIndex >= 0
                ? preferredIndex
                : (defaultIndex >= 0 ? defaultIndex : 0);
            if (preferredIndex < 0) {
                const fallbackLabel = resolvedLevel === defaultIndex && defaultIndex >= 0
                    ? 'default'
                    : 'first available';
                console.log(`Fallback to ${fallbackLabel} quality level (${resolvedLevel}).`);
            }
            overlayHls.currentLevel = resolvedLevel;
        }
        overlayHls.startLoad(safeStartTime);

        if (safeStartTime > 0) {
            const applyInitialSeek = () => {
                ignoreSeekEvent = true;
                if (ignoreSeekResetTimer) {
                    clearTimeout(ignoreSeekResetTimer);
                }
                const resetIgnoreSeek = () => {
                    if (ignoreSeekResetTimer) {
                        clearTimeout(ignoreSeekResetTimer);
                        ignoreSeekResetTimer = null;
                    }
                    ignoreSeekEvent = false;
                    overlayVideoContainer.removeEventListener('seeked', resetIgnoreSeek);
                };
                overlayVideoContainer.addEventListener('seeked', resetIgnoreSeek);
                ignoreSeekResetTimer = setTimeout(resetIgnoreSeek, INITIAL_SEEK_SETTLE_TIME);
                overlayVideoContainer.currentTime = safeStartTime;
            };

            if (overlayVideoContainer.readyState >= 1) {
                applyInitialSeek();
            } else {
                overlayVideoContainer.addEventListener('loadedmetadata', applyInitialSeek, { once: true });
            }
        }

        if (shouldAutoPlay) {
            setTimeout(() => {
                if (overlayVideoContainer.readyState >= 2) {
                    programmaticPlay = true;
                    attemptPlayback(overlayVideoContainer);
                } else {
                    const checkReady = setInterval(() => {
                        if (overlayVideoContainer.readyState >= 2) {
                            clearInterval(checkReady);
                            programmaticPlay = true;
                            attemptPlayback(overlayVideoContainer);
                        }
                    }, 500);

                    setTimeout(() => clearInterval(checkReady), 30000);
                }
            }, 1500);
        }
    });
}

/**
 * Opens the overlay player and starts playback.
 * @param {number} videoId - The video ID.
 * @param {string} resolution - The resolution to play.
 */
function openVideoOverlay(videoId, resolution) {
    const video = VIDEOS.find(video => video.id == videoId);
    if (!video) return;

    hideHeader();
    const overlay = document.getElementById('overlay');
    overlay.style.display = 'flex';
    document.body.classList.add('overlay-open');
    document.getElementById('overlayTitle').innerHTML = video.title;
    const resolutionSelect = document.getElementById('setResolution');
    if (resolutionSelect) {
        resolutionSelect.value = resolution;
    }
    currentResolution = resolution;
    loadVideoInOverlay(videoId, resolution);
    document.body.style.overflow = 'hidden';

}

/**
 * Closes the overlay video player and resets the UI.
 */
function closeVideoOverlay() {
    const overlay = document.getElementById('overlay');
    overlay.style.display = 'none';

    document.body.classList.remove('overlay-open');

    showHeader();

    if (overlayHls) {
        overlayHls.destroy();
        overlayHls = null;
    }

    overlayVideoContainer.pause();
    overlayVideoContainer.src = '';

    document.body.style.overflow = 'auto';
}

/**
 * Opens the video overlay for the given video.
 * @param {number} id - The video ID.
 */
function playVideo(id) {
    if (!id) {
        id = currentVideo;
    }
    openVideoOverlay(id, currentResolution);
}

/**
 * Hides the main header (e.g., when playing video fullscreen).
 */
function hideHeader() {
    const header = document.querySelector('.main_header');
    if (header) {
        header.style.transform = 'translateY(-100%)';
        header.style.opacity = '0';
        header.style.transition = 'transform 0.3s ease-in-out, opacity 0.3s ease-in-out';
    }
}

/**
 * Shows the main header again.
 */
function showHeader() {
    const header = document.querySelector('.main_header');
    if (header) {
        header.style.transform = 'translateY(0)';
        header.style.opacity = '1';
        header.style.transition = 'transform 0.3s ease-in-out, opacity 0.3s ease-in-out';
    }
}

/**
 * Closes the overlay when the Escape key is pressed.
 */
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeVideoOverlay();
    }
});
