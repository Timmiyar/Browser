"use strict";

// Aurora Browser Main JavaScript
// A Chrome-like browser interface with aurora:// protocol support using Scramjet

// ==================== Configuration ====================
const AURORA_PROTOCOL_MAPPINGS = {
  "chat": "https://talkly-vcjh.onrender.com/",
  "post": "https://uni-post.onrender.com/",
  "home": "aurora://home",
  "settings": "aurora://settings",
  "history": "aurora://history",
  "bookmarks": "aurora://bookmarks",
  "extensions": "aurora://extensions",
  "restart": "aurora://restart"
};

const DEFAULT_SETTINGS = {
  searchEngine: "https://www.google.com/search?q=%s",
  theme: "dark",
  showBookmarksBar: true,
  performanceMode: false // Renamed from useV8Optimization
};

const DEFAULT_MARKETPLACE_INDEX = "https://sirco-web.github.io/extentions-aurora/index.json";

const BUILTIN_THEMES = [
  { id: "dark", name: "Dark (Default)" },
  { id: "light", name: "Light" },
  { id: "midnight", name: "Midnight Blue" },
  { id: "forest", name: "Forest Green" },
  { id: "sunset", name: "Sunset Orange" },
  { id: "ocean", name: "Deep Ocean" },
  { id: "hacker", name: "Hacker Green" }
];

// ==================== State ====================
let tabs = [];
let activeTabId = null;
let bookmarks = [];
let history = [];
let extensions = [];
let customThemes = {}; // Store registered custom themes
let settings = { ...DEFAULT_SETTINGS };
let connection = null;
let scramjet = null;
let devtoolsOpen = false;
let isInspecting = false; // New state for inspect mode
let devtoolsHeight = 300; // Default height
let networkRequests = [];
let consoleMessages = [];
let currentExtensionTab = 'installed';
let isIncognito = false;
let preIncognitoSnapshot = null; // Store main session data
let toolbarActions = {}; // Store extension toolbar icons

// Extension hooks
let requestInterceptors = [];
let tabLoadListeners = [];

// ==================== DOM Elements ====================
const elements = {};

// ==================== Utilities ====================
// Moved up to prevent initialization errors
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function extractTitle(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return url;
  }
}

function extractFileName(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const fileName = path.split("/").pop() || urlObj.hostname;
    return fileName.length > 40 ? fileName.substring(0, 40) + "..." : fileName;
  } catch (e) {
    return String(url).substring(0, 40);
  }
}

// ==================== Offline Manager ====================
const OfflineManager = {
    dbName: 'AuroraOfflineCache',
    version: 1,
    enabled: false, // Requires extension to enable
    
    enable() {
        this.enabled = true;
        addConsoleMessage("info", "Offline Manager enabled by extension.");
    },
    
    disable() {
        this.enabled = false;
        addConsoleMessage("info", "Offline Manager disabled.");
    },

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('pages')) {
                    db.createObjectStore('pages', { keyPath: 'url' });
                }
            };
        });
    },

    async savePage(url, title, content) {
        if (!this.enabled) return false;
        try {
            const db = await this.open();
            const tx = db.transaction('pages', 'readwrite');
            const store = tx.objectStore('pages');
            await new Promise((resolve, reject) => {
                const req = store.put({
                    url: url,
                    title: title,
                    content: content,
                    timestamp: Date.now()
                });
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            addConsoleMessage("info", `Page saved for offline: ${url}`);
            return true;
        } catch (e) {
            console.error("Offline save failed:", e);
            addConsoleMessage("error", "Failed to save page offline.");
            return false;
        }
    },

    async getPage(url) {
        if (!this.enabled) return null;
        try {
            const db = await this.open();
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            return new Promise((resolve, reject) => {
                const req = store.get(url);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return null;
        }
    },

    async hasPage(url) {
        if (!this.enabled) return false;
        try {
            const db = await this.open();
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            return new Promise((resolve, reject) => {
                const req = store.count(url);
                req.onsuccess = () => resolve(req.result > 0);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return false;
        }
    },

    async getAllPages() {
        try {
            const db = await this.open();
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            return new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return [];
        }
    },

    async deletePage(url) {
        try {
            const db = await this.open();
            const tx = db.transaction('pages', 'readwrite');
            const store = tx.objectStore('pages');
            await new Promise((resolve, reject) => {
                const req = store.delete(url);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            return true;
        } catch (e) {
            return false;
        }
    },

    // Helper for extensions to download and save a URL directly
    async downloadAndSave(url) {
        if (!this.enabled) return false;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch ${url}`);
            const content = await res.text();
            
            // Try to extract title
            let title = url;
            const titleMatch = content.match(/<title>(.*?)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
                title = titleMatch[1];
            }
            
            return await this.savePage(url, title, content);
        } catch (e) {
            console.error("Offline download failed:", e);
            return false;
        }
    }
};

// ==================== Initialization ====================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    initializeElements(); // Initialize elements first
    injectBuiltinThemes(); // Inject CSS for built-in themes
    loadSettings();
    loadBookmarks();
    loadHistory();
    loadCustomThemes(); // Load custom themes
    loadExtensions();
    applyTheme();
    setupEventListeners();
    setupKeyboardShortcuts();
    applyPerformanceMode(); // Apply optimizations on startup
    
    // Initialize Scramjet
    try {
      if (typeof $scramjetLoadController !== 'undefined') {
        const { ScramjetController } = $scramjetLoadController();
        scramjet = new ScramjetController({
          files: {
            wasm: '/scram/scramjet.wasm.wasm',
            all: '/scram/scramjet.all.js',
            sync: '/scram/scramjet.sync.js',
          },
        });
        scramjet.init();
        addConsoleMessage("info", "Scramjet initialized successfully");
      } else {
        console.warn("Scramjet controller not loaded");
      }
      
      // Initialize BareMux connection
      if (typeof BareMux !== 'undefined') {
        connection = new BareMux.BareMuxConnection("/baremux/worker.js");
      }
    } catch (err) {
      console.error("Failed to initialize Scramjet:", err);
      addConsoleMessage("error", `Failed to initialize Scramjet: ${err.message}`);
    }
    
    // Create initial tab
    createTab("aurora://home", "New Tab");

    // Expose Aurora API for extensions
    window.aurora = {
      get tabs() { return tabs; },
      get activeTabId() { return activeTabId; },
      get settings() { return settings; },
      get connection() { return connection; },
      get isIncognito() { return isIncognito; },
      navigate,
      createTab,
      closeTab,
      refresh,
      goBack,
      goForward,
      // New hooks
      onBeforeNavigate: (callback) => requestInterceptors.push(callback),
      onTabLoaded: (callback) => tabLoadListeners.push(callback),
      
      // UI Hooks
      registerToolbarAction: (id, icon, onClick) => {
          toolbarActions[id] = { icon, onClick };
          renderToolbarActions();
      },
      
      showPopup: (html) => {
          // Remove existing popup
          const existing = document.getElementById('aurora-ext-popup');
          if (existing) existing.remove();
          
          const popup = document.createElement('div');
          popup.id = 'aurora-ext-popup';
          popup.style.cssText = `
              position: absolute;
              top: 50px;
              right: 10px;
              width: 320px;
              max-height: 500px;
              background: var(--bg-secondary);
              border: 1px solid var(--border-color);
              border-radius: 12px;
              box-shadow: 0 10px 25px rgba(0,0,0,0.5);
              z-index: 10000;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              animation: slideDown 0.2s ease-out;
          `;
          
          // Add animation style if not exists
          if (!document.getElementById('popup-anim-style')) {
              const style = document.createElement('style');
              style.id = 'popup-anim-style';
              style.textContent = `@keyframes slideDown { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:translateY(0); } }`;
              document.head.appendChild(style);
          }

          // Close on click outside
          const closeHandler = (e) => {
              if (!popup.contains(e.target) && !e.target.closest('.ext-toolbar-btn')) {
                  popup.remove();
                  document.removeEventListener('click', closeHandler);
              }
          };
          
          // Delay adding listener to avoid immediate close
          setTimeout(() => document.addEventListener('click', closeHandler), 100);
          
          popup.innerHTML = html;
          document.body.appendChild(popup);
      },

      registerTheme: (id, name, css) => {
        customThemes[id] = { name, css };
        saveCustomThemes();
        // Refresh selector if settings page is open
        if (elements.settingsPage && !elements.settingsPage.classList.contains("hidden")) {
            populateSettingsPage();
        }
        // Re-apply if this is the active theme
        if (settings.theme === id) {
            applyTheme();
        }
      },
      injectCSS: (tabId, css) => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab && tab.frame) {
            try {
                const doc = tab.frame.contentDocument || tab.frame.contentWindow.document;
                if (doc) {
                    const style = doc.createElement('style');
                    style.textContent = css;
                    doc.head.appendChild(style);
                }
            } catch(e) {
                console.warn("Failed to inject CSS:", e);
            }
        }
      },
      toggleIncognito: async (state) => {
        if (typeof state === 'boolean') isIncognito = state;
        else isIncognito = !isIncognito;
        
        const toolbar = document.getElementById('extensions-toolbar');
        const incognitoBtnId = 'incognito-toggle-btn';
        
        if (isIncognito) {
            document.body.classList.add('incognito-mode');
            addConsoleMessage("info", "Incognito Mode Enabled");
            
            // Hide other extension buttons
            if (toolbar) {
                Array.from(toolbar.children).forEach(child => {
                    if (child.id !== incognitoBtnId) {
                        child.style.display = 'none';
                    }
                });
            }
            
            // 1. SNAPSHOT MAIN SESSION (Save current data)
            preIncognitoSnapshot = {
                localStorage: JSON.stringify(localStorage),
                sessionStorage: JSON.stringify(sessionStorage),
                cookies: document.cookie
            };

            // 2. CLEAR SESSION DATA (Start fresh for Incognito)
            // Preserve BareMux/Transport keys to avoid breaking the connection
            const keysToPreserve = [];
            for(let i=0; i<localStorage.length; i++) {
                const key = localStorage.key(i);
                if(key && (key.startsWith('bare') || key.includes('transport') || key.includes('wisp'))) {
                    keysToPreserve.push({key, val: localStorage.getItem(key)});
                }
            }

            localStorage.clear();
            sessionStorage.clear();
            
            // Restore infrastructure keys
            keysToPreserve.forEach(k => localStorage.setItem(k.key, k.val));
            
            const cookies = document.cookie.split(";");
            for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i].trim();
                const eqPos = cookie.indexOf("=");
                const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                
                // Preserve infrastructure cookies (GitHub Codespaces, Cloudflare, etc.)
                if (name.toLowerCase().match(/(github|codespace|auth|token|cf_|__host|__secure|wisp|epoxy|bare)/)) {
                    continue;
                }

                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
            }
            
            // Restore Aurora settings immediately so the browser still works
            saveSettings();
            saveBookmarksToStorage();
            saveHistoryToStorage();
            saveExtensions();
            saveCustomThemes();

            // DO NOT force re-register SW or re-configure transport if they are already working.
            if (!navigator.serviceWorker.controller) {
                 try { await registerSW(); } catch(e) {}
            }
            
            if (!connection) {
                await configureTransport();
            }

        } else {
            document.body.classList.remove('incognito-mode');
            addConsoleMessage("info", "Incognito Mode Disabled");
            
            // Show other extension buttons
            if (toolbar) {
                Array.from(toolbar.children).forEach(child => {
                    child.style.display = '';
                });
            }
            
            // 3. WIPE INCOGNITO DATA
            localStorage.clear();
            sessionStorage.clear();
            const cookies = document.cookie.split(";");
            for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i].trim();
                const eqPos = cookie.indexOf("=");
                const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;

                // Preserve infrastructure cookies here too
                if (name.toLowerCase().match(/(github|codespace|auth|token|cf_|__host|__secure|wisp|epoxy|bare)/)) {
                    continue;
                }

                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
            }

            // 4. RESTORE MAIN SESSION
            if (preIncognitoSnapshot) {
                // Restore LocalStorage
                if (preIncognitoSnapshot.localStorage) {
                    const ls = JSON.parse(preIncognitoSnapshot.localStorage);
                    Object.keys(ls).forEach(key => localStorage.setItem(key, ls[key]));
                }
                // Restore SessionStorage
                if (preIncognitoSnapshot.sessionStorage) {
                    const ss = JSON.parse(preIncognitoSnapshot.sessionStorage);
                    Object.keys(ss).forEach(key => sessionStorage.setItem(key, ss[key]));
                }
                // Restore Cookies
                if (preIncognitoSnapshot.cookies) {
                    const savedCookies = preIncognitoSnapshot.cookies.split(';');
                    savedCookies.forEach(c => {
                        if(c.trim()) document.cookie = c.trim();
                    });
                }
                
                saveSettings();
                saveBookmarksToStorage();
                saveHistoryToStorage();
                saveExtensions();
                saveCustomThemes();
                
                preIncognitoSnapshot = null;
                addConsoleMessage("info", "Main session restored.");
            }
            
            // Ensure transport is still good
            if (!connection) {
                await configureTransport();
            }
        }
        return isIncognito;
      },
      // Explicit access to global scope for extensions
      get global() { return window; },
      get document() { return document; },
      
      // EXPOSED INTERNALS: Allow extensions to access and modify everything
      elements: elements,
      internals: {
        // State Getters/Setters
        get tabs() { return tabs; },
        set tabs(v) { tabs = v; },
        get bookmarks() { return bookmarks; },
        set bookmarks(v) { bookmarks = v; },
        get history() { return history; },
        set history(v) { history = v; },
        get extensions() { return extensions; },
        set extensions(v) { extensions = v; },
        
        // Core Functions
        initializeElements,
        setupEventListeners,
        setupKeyboardShortcuts,
        createTab,
        closeTab,
        activateTab,
        renderTabs,
        navigate,
        parseUrl,
        proxyNavigate,
        configureTransport,
        setupFrameListeners,
        updateTabUrlFromFrame,
        navigateFromUrlBar,
        searchFromHome,
        updateUrlBar,
        updateNavigationButtons,
        goBack,
        goForward,
        navigateToHistoryEntry,
        refresh,
        showInternalPage,
        handleRestart,
        populateSettingsPage,
        
        // Data Management
        loadBookmarks,
        saveBookmarksToStorage,
        renderBookmarksBar,
        renderBookmarksPage,
        toggleBookmarkDialog,
        hideBookmarkDialog,
        saveBookmark,
        clearBookmarks,
        loadHistory,
        saveHistoryToStorage,
        addToHistory,
        renderHistoryPage,
        clearHistory,
        clearSiteData,
        loadSettings,
        saveSettings,
        applyTheme,
        updateBookmarksBarVisibility,
        resetSettings,
        
        // Extension Management
        loadExtensions,
        saveExtensions,
        installExtensionFromUrl,
        installExtensionFromCode,
        parseExtensionFile,
        runExtension,
        renderExtensionsPage,
        renderInstalledExtensions,
        toggleExtension,
        deleteExtension,
        renderMarketplacePage,
        fetchMarketplaceIndex,
        renderMarketplaceItems,
        installMarketplaceUrl,
        
        // DevTools & UI
        toggleDevTools,
        switchDevToolsTab,
        renderDevToolsContent,
        renderDomNode,
        addConsoleMessage,
        renderConsoleOutput,
        executeConsoleCommand,
        addNetworkRequest,
        renderNetworkList,
        clearNetworkLog,
        showStorageContent,
        handleContextMenu,
        toggleMainMenu,
        hideMenus,
        handleContextMenuAction,
        handleMainMenuAction,
        
        // Utils
        escapeHtml,
        extractTitle,
        extractFileName,
        applyPerformanceMode,
        
        // Offline
        OfflineManager,
        saveCurrentPageForOffline: async () => {
            if (!OfflineManager.enabled) {
                alert("Offline mode is not enabled. Please install an Offline Manager extension.");
                return;
            }
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab || !tab.frame) return;
            try {
                // Attempt to grab content. Note: May fail if cross-origin restricted.
                const doc = tab.frame.contentDocument;
                if (doc) {
                    const content = doc.documentElement.outerHTML;
                    const success = await OfflineManager.savePage(tab.url, tab.title, content);
                    if (success) alert("Page saved for offline reading!");
                } else {
                    alert("Cannot save this page (Access Denied to frame content).");
                }
            } catch (e) {
                alert("Failed to save page: " + e.message);
            }
        }
      }
    };

    // Run enabled extensions
    extensions.forEach(ext => {
      if (ext.enabled) runExtension(ext);
    });
  } catch (e) {
    console.error("Critical initialization error:", e);
    alert("Browser initialization failed: " + e.message);
  }
});

function initializeElements() {
  // Tab bar
  elements.tabs = document.getElementById("tabs-container");
  
  // Navigation
  elements.backBtn = document.getElementById("back-btn");
  elements.forwardBtn = document.getElementById("forward-btn");
  elements.refreshBtn = document.getElementById("refresh-btn");
  elements.homeBtn = document.getElementById("home-btn");
  elements.urlProtocol = document.getElementById("url-protocol");
  elements.urlBar = document.getElementById("url-bar");
  elements.goBtn = document.getElementById("go-btn");
  
  // Toolbar
  elements.extensionsToolbar = document.getElementById("extensions-toolbar");
  elements.extensionsBtn = document.getElementById("extensions-btn");
  elements.bookmarkBtn = document.getElementById("bookmark-btn");
  elements.devtoolsBtn = document.getElementById("devtools-btn");
  elements.settingsBtn = document.getElementById("settings-btn");
  elements.menuBtn = document.getElementById("menu-btn");
  
  // Bookmarks bar
  elements.bookmarksBar = document.getElementById("bookmarks-bar");
  elements.bookmarksList = document.getElementById("bookmarks-list");
  
  // Main content
  elements.mainContent = document.getElementById("main-content");
  elements.frameContainer = document.getElementById("browser-frame-container");
  elements.homePage = document.getElementById("home-page");
  elements.settingsPage = document.getElementById("settings-page");
  elements.historyPage = document.getElementById("history-page");
  elements.bookmarksPage = document.getElementById("bookmarks-page");
  elements.extensionsPage = document.getElementById("extensions-page");
  
  // Home page
  elements.homeSearch = document.getElementById("home-search");
  elements.homeSearchBtn = document.getElementById("home-search-btn");
  
  // DevTools
  elements.devtoolsPanel = document.getElementById("devtools-panel");
  
  // Initialize DevTools UI (Resize handle & Inspect button)
  if (elements.devtoolsPanel) {
      setupDevToolsUI();
  }

  elements.closeDevtools = document.getElementById("close-devtools");
  elements.consoleOutput = document.getElementById("console-output");
  elements.consoleInput = document.getElementById("console-input");
  elements.networkList = document.getElementById("network-list");
  
  // Menus
  elements.contextMenu = document.getElementById("context-menu");
  elements.mainMenu = document.getElementById("main-menu");
  
  // Dialogs
  elements.bookmarkDialogOverlay = document.getElementById("bookmark-dialog-overlay");
  elements.bookmarkName = document.getElementById("bookmark-name");
  elements.bookmarkUrl = document.getElementById("bookmark-url");
  elements.bookmarkSave = document.getElementById("bookmark-save");
  elements.bookmarkCancel = document.getElementById("bookmark-cancel");

  // Extension controls
  elements.extensionCodeInput = document.getElementById("extension-code-input");
  elements.installCodeBtn = document.getElementById("install-code-btn");
  elements.extensionUrlInput = document.getElementById("extension-url-input");
  elements.extensionInstall = document.getElementById("install-url-btn");
  elements.extensionsList = document.getElementById("extensions-list");
  
  // Marketplace controls
  elements.openMarketplaceBtn = document.getElementById("open-marketplace-btn");
  elements.marketplaceIndexUrl = document.getElementById("marketplace-index-url");
  elements.marketplaceRefreshBtn = document.getElementById("marketplace-refresh-btn");
  elements.marketplaceList = document.getElementById("marketplace-list");
  
  // Settings controls
  elements.searchEngine = document.getElementById("search-engine");
  elements.themeSelect = document.getElementById("theme");
  elements.showBookmarksBar = document.getElementById("show-bookmarks-bar");
  
  // Add Save Theme Button
  if (elements.themeSelect && !document.getElementById("save-theme-btn")) {
      const saveBtn = document.createElement("button");
      saveBtn.id = "save-theme-btn";
      saveBtn.className = "settings-btn primary";
      saveBtn.textContent = "Save Theme";
      saveBtn.style.marginTop = "10px";
      saveBtn.onclick = () => {
          settings.theme = elements.themeSelect.value;
          saveSettings();
          applyTheme();
          const originalText = saveBtn.textContent;
          saveBtn.textContent = "Saved!";
          setTimeout(() => saveBtn.textContent = originalText, 1000);
      };
      elements.themeSelect.parentNode.appendChild(saveBtn);
  }
  
  // Inject Performance Setting
  if (!document.getElementById("performance-mode") && elements.settingsPage) {
      const container = document.createElement("div");
      container.className = "settings-section";
      container.innerHTML = `
        <h3>Performance</h3>
        <div class="setting-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0;">
            <div style="flex: 1; padding-right: 20px;">
                <span style="font-weight: 500; font-size: 15px;">Game / Focus Mode</span>
                <p class="setting-desc" style="margin: 5px 0 0; font-size: 13px; opacity: 0.7; line-height: 1.4;">
                    Maximizes browser speed by disabling animations, background logs, and extensions. Forces single-tab focus and optimizes rendering for games.
                </p>
            </div>
            <label style="position: relative; display: inline-block; width: 50px; height: 24px;">
                <input type="checkbox" id="performance-mode" style="opacity: 0; width: 0; height: 0;">
                <span class="slider" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--bg-tertiary); transition: .4s; border-radius: 34px;"></span>
                <span class="slider-knob" style="position: absolute; content: ''; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%;"></span>
            </label>
            <style>
                #performance-mode:checked + .slider { background-color: var(--accent-color); }
                #performance-mode:checked + .slider .slider-knob { transform: translateX(26px); }
            </style>
        </div>
      `;
      
      // Insert before the Danger Zone or About section
      const dangerZone = elements.settingsPage.querySelector(".danger-zone");
      const aboutBox = elements.settingsPage.querySelector(".about-section"); // Assuming class name
      
      if (aboutBox) {
          elements.settingsPage.insertBefore(container, aboutBox);
      } else if (dangerZone) {
          elements.settingsPage.insertBefore(container, dangerZone);
      } else {
          elements.settingsPage.appendChild(container);
      }
  }
  elements.performanceMode = document.getElementById("performance-mode");
}

// ==================== Event Listeners ====================
function setupEventListeners() {
  // Navigation
  if (elements.backBtn) elements.backBtn.addEventListener("click", () => window.aurora.goBack());
  if (elements.forwardBtn) elements.forwardBtn.addEventListener("click", () => window.aurora.goForward());
  if (elements.refreshBtn) elements.refreshBtn.addEventListener("click", () => window.aurora.refresh());
  if (elements.homeBtn) elements.homeBtn.addEventListener("click", () => window.aurora.navigate("aurora://home"));
  if (elements.goBtn) elements.goBtn.addEventListener("click", () => navigateFromUrlBar());
  
  if (elements.urlBar) {
    elements.urlBar.addEventListener("keypress", (e) => {
      if (e.key === "Enter") navigateFromUrlBar();
    });
    elements.urlBar.addEventListener("focus", () => {
      elements.urlBar.select();
    });
  }
  
  // Toolbar
  if (elements.extensionsBtn) elements.extensionsBtn.addEventListener("click", () => window.aurora.navigate("aurora://extensions"));
  if (elements.bookmarkBtn) elements.bookmarkBtn.addEventListener("click", toggleBookmarkDialog);
  if (elements.devtoolsBtn) elements.devtoolsBtn.addEventListener("click", toggleDevTools);
  if (elements.settingsBtn) elements.settingsBtn.addEventListener("click", () => window.aurora.navigate("aurora://settings"));
  
  if (elements.menuBtn) {
    elements.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMainMenu();
    });
  }
  
  // Home page
  if (elements.homeSearch) {
    elements.homeSearch.addEventListener("keypress", (e) => {
      if (e.key === "Enter") searchFromHome();
    });
  }
  if (elements.homeSearchBtn) elements.homeSearchBtn.addEventListener("click", searchFromHome);
  
  // Quick links
  document.querySelectorAll(".quick-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.aurora.navigate(link.dataset.url);
    });
  });
  
  // DevTools
  if (elements.closeDevtools) elements.closeDevtools.addEventListener("click", () => toggleDevTools(false));
  document.querySelectorAll(".devtools-tab").forEach(tab => {
    tab.addEventListener("click", () => switchDevToolsTab(tab.dataset.panel));
  });
  if (elements.consoleInput) {
    elements.consoleInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") executeConsoleCommand();
    });
  }

  const clearNetworkBtn = document.getElementById("clear-network");
  if (clearNetworkBtn) clearNetworkBtn.addEventListener("click", clearNetworkLog);
  
  // Application panel
  document.querySelectorAll(".app-item").forEach(item => {
    item.addEventListener("click", () => showStorageContent(item.dataset.type));
  });
  
  // Context menu
  document.addEventListener("contextmenu", handleContextMenu);
  document.addEventListener("click", hideMenus);
  document.querySelectorAll(".context-menu-item").forEach(item => {
    item.addEventListener("click", () => handleContextMenuAction(item.dataset.action));
  });
  
  // Main menu
  document.querySelectorAll(".menu-item").forEach(item => {
    item.addEventListener("click", () => handleMainMenuAction(item.dataset.action));
  });
  
  // Bookmark dialog
  if (elements.bookmarkCancel) elements.bookmarkCancel.addEventListener("click", hideBookmarkDialog);
  if (elements.bookmarkSave) elements.bookmarkSave.addEventListener("click", saveBookmark);
  
  // Extensions
  if (elements.installCodeBtn) {
    elements.installCodeBtn.addEventListener("click", installExtensionFromCode);
  }
  if (elements.extensionInstall) {
    elements.extensionInstall.addEventListener("click", installExtensionFromUrl);
  }
  
  // Marketplace
  if (elements.openMarketplaceBtn) {
    elements.openMarketplaceBtn.addEventListener("click", () => {
      renderMarketplacePage();
      navigate("aurora://extensions");
    });
  }
  if (elements.marketplaceRefreshBtn) {
    elements.marketplaceRefreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      renderMarketplacePage();
    });
  }
  if (elements.marketplaceIndexUrl) {
    elements.marketplaceIndexUrl.addEventListener("change", () => renderMarketplacePage());
  }
  
  // Settings
  if (elements.searchEngine) {
    elements.searchEngine.addEventListener("change", () => {
      settings.searchEngine = elements.searchEngine.value;
      saveSettings();
    });
  }
  if (elements.themeSelect) {
    elements.themeSelect.addEventListener("change", () => {
      settings.theme = elements.themeSelect.value;
      saveSettings();
      applyTheme();
    });
  }
  if (elements.showBookmarksBar) {
    elements.showBookmarksBar.addEventListener("change", () => {
      settings.showBookmarksBar = elements.showBookmarksBar.checked;
      saveSettings();
      updateBookmarksBarVisibility();
    });
  }

  if (elements.performanceMode) {
    elements.performanceMode.addEventListener("change", () => {
        settings.performanceMode = elements.performanceMode.checked;
        saveSettings();
        applyPerformanceMode(true);
    });
  }
  
  const clearHistoryBtn = document.getElementById("clear-history");
  if (clearHistoryBtn) clearHistoryBtn.addEventListener("click", clearHistory);
  
  const clearBookmarksBtn = document.getElementById("clear-bookmarks");
  if (clearBookmarksBtn) clearBookmarksBtn.addEventListener("click", clearBookmarks);
  
  const resetSettingsBtn = document.getElementById("reset-settings");
  if (resetSettingsBtn) resetSettingsBtn.addEventListener("click", resetSettings);
  
  const clearAllHistoryBtn = document.getElementById("clear-all-history");
  if (clearAllHistoryBtn) clearAllHistoryBtn.addEventListener("click", clearHistory);
}

function setupKeyboardShortcuts() {
  window.addEventListener("keydown", (e) => {
    // Ctrl+T: New tab
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
      e.preventDefault();
      e.stopPropagation();
      createTab("aurora://home", "New Tab");
    }
    // Ctrl+W: Close tab
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      e.stopPropagation();
      if (activeTabId) closeTab(activeTabId);
    }
    // Ctrl+L: Focus URL bar
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopPropagation();
      if (elements.urlBar) {
        elements.urlBar.focus();
        elements.urlBar.select();
      }
    }
    // Alt+Left: Back
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      goBack();
    }
    // Alt+Right: Forward
    if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      goForward();
    }
    // F5: Refresh
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      refresh();
    }
    // F12: DevTools
    if (e.key === "F12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i")) {
      e.preventDefault();
      toggleDevTools();
    }
    // Ctrl+D: Bookmark
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      toggleBookmarkDialog();
    }
    // Ctrl+H: History
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
      e.preventDefault();
      navigate("aurora://history");
    }
    // Ctrl+B: Bookmarks
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      navigate("aurora://bookmarks");
    }
    // Escape: Close menus
    if (e.key === "Escape") {
      hideMenus();
      hideBookmarkDialog();
    }
  }, true);
}

function applyPerformanceMode(fromUserAction = false) {
  // Remove old styles
  const oldStyle = document.getElementById('perf-styles');
  if (oldStyle) oldStyle.remove();
  const v8Style = document.getElementById('v8-styles');
  if (v8Style) v8Style.remove();

  if (settings.performanceMode) {
      document.body.classList.add('perf-mode');
      
      // Inject CSS to kill expensive UI effects and hide clutter
      const style = document.createElement('style');
      style.id = 'perf-styles';
      style.textContent = `
          body.perf-mode * {
              backdrop-filter: none !important;
              box-shadow: none !important;
              text-shadow: none !important;
              transition: none !important;
              animation: none !important;
              border-radius: 0 !important;
              scroll-behavior: auto !important;
          }
          /* Hide Tab Bar */
          body.perf-mode #tabs-container {
              display: none !important;
          }
          /* Hide Extensions Toolbar */
          body.perf-mode #extensions-toolbar {
              display: none !important;
          }
          /* Optimize Frame */
          body.perf-mode .browser-frame {
              transform: translateZ(0);
              will-change: transform, opacity;
              image-rendering: optimizeSpeed; /* Firefox */
              image-rendering: pixelated; /* Chrome */
              contain: strict;
          }
          /* Minimalist UI */
          body.perf-mode .nav-btn, 
          body.perf-mode #url-bar {
              border: 1px solid #444 !important;
              background: #111 !important;
              color: #0f0 !important;
          }
      `;
      document.head.appendChild(style);
      
      addConsoleMessage("info", "🚀 Performance Mode Enabled: Extensions disabled, UI simplified.");
      
      // Notify user about extensions ONLY if this was a user action (toggle)
      // On startup, extensions are already disabled by runExtension check, so no need to reload.
      if (fromUserAction && extensions.some(e => e.enabled)) {
          const shouldReload = confirm("Performance Mode enabled. Extensions will be disabled. Reload now to apply changes?");
          if (shouldReload) {
              window.location.reload();
          }
      }

  } else {
      document.body.classList.remove('perf-mode');
      addConsoleMessage("info", "Performance Mode Disabled.");
      
      // Notify user to re-enable extensions
      if (fromUserAction && extensions.some(e => e.enabled)) {
           // We don't force reload here, but extensions won't start until reload if they were suppressed
           addConsoleMessage("info", "Reload to re-enable extensions.");
      }
  }
}


// ==================== Tab Management ====================
function createTab(url = "aurora://home", title = "New Tab") {
  if (settings.performanceMode && tabs.length >= 1) {
      alert("Game Mode is active. Only one tab is allowed.");
      return null;
  }

  const tabId = "tab-" + Date.now();
  const tab = {
    id: tabId,
    url: url,
    title: title,
    favicon: "🌌",
    history: [url],
    historyIndex: 0,
    frame: null,
    scramjetFrame: null
  };
  
  tabs.push(tab);
  renderTabs();
  activateTab(tabId);
  navigate(url, tabId);
  
  return tabId;
}

function closeTab(tabId) {
  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;
  
  const tab = tabs[index];
  
  // Remove frame if exists
  if (tab.frame) {
    tab.frame.remove();
  }
  if (tab.urlPollingInterval) {
    clearInterval(tab.urlPollingInterval);
  }
  
  tabs.splice(index, 1);
  
  if (tabs.length === 0) {
    // Create a new tab if all tabs are closed
    createTab("aurora://home", "New Tab");
  } else if (activeTabId === tabId) {
    // Activate another tab
    const newIndex = Math.min(index, tabs.length - 1);
    activateTab(tabs[newIndex].id);
  } else {
    renderTabs();
  }
}

function activateTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  
  activeTabId = tabId;
  
  // Update tab UI
  renderTabs();
  
  // Hide all frames and pages
  document.querySelectorAll(".browser-frame").forEach(f => f.classList.remove("active"));
  if (elements.homePage) elements.homePage.classList.add("hidden");
  if (elements.settingsPage) elements.settingsPage.classList.add("hidden");
  if (elements.historyPage) elements.historyPage.classList.add("hidden");
  if (elements.bookmarksPage) elements.bookmarksPage.classList.add("hidden");
  if (elements.extensionsPage) elements.extensionsPage.classList.add("hidden");
  
  // Show active content
  if (tab.url.startsWith("aurora://")) {
    const page = tab.url.replace("aurora://", "");
    if (AURORA_PROTOCOL_MAPPINGS[page] && !AURORA_PROTOCOL_MAPPINGS[page].startsWith("aurora://")) {
      // This is a proxied aurora:// URL, show the frame
      if (tab.frame) tab.frame.classList.add("active");
    } else {
      showInternalPage(page);
    }
    
    // Update history
    if (tab.history[tab.historyIndex] !== tab.url) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(tab.url);
      tab.historyIndex = tab.history.length - 1;
    }
    
    updateUrlBar(tab.url);
    updateNavigationButtons();
    renderTabs();
    addToHistory(tab.url, tab.title);
    return;
  } else if (tab.frame) {
    tab.frame.classList.add("active");
  }
  
  // Update URL bar
  updateUrlBar(tab.url);
  updateNavigationButtons();
}

function renderTabs() {
  if (!elements.tabs) return;
  elements.tabs.innerHTML = "";
  
  tabs.forEach(tab => {
    const tabEl = document.createElement("div");
    tabEl.className = "tab" + (tab.id === activeTabId ? " active" : "");
    tabEl.innerHTML = `
      <span class="tab-favicon">${tab.favicon}</span>
      <span class="tab-title">${escapeHtml(tab.title)}</span>
      <span class="tab-close" data-id="${tab.id}">×</span>
    `;
    
    tabEl.addEventListener("click", (e) => {
      if (!e.target.classList.contains("tab-close")) {
        activateTab(tab.id);
      }
    });
    
    tabEl.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    
    elements.tabs.appendChild(tabEl);
  });

  // Add New Tab Button at the end
  const newTabBtn = document.createElement("button");
  newTabBtn.className = "new-tab-btn";
  newTabBtn.innerHTML = "+";
  newTabBtn.title = "New Tab";
  newTabBtn.addEventListener("click", () => createTab("aurora://home", "New Tab"));
  elements.tabs.appendChild(newTabBtn);
}

// ==================== Navigation ====================
function navigate(input, tabId = activeTabId, options = {}) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  
  let url = input.trim();
  
  // Parse aurora:// URLs
  if (url.startsWith("aurora://")) {
    const page = url.replace("aurora://", "");
    
    // Check if it maps to an external URL
    if (AURORA_PROTOCOL_MAPPINGS[page] && !AURORA_PROTOCOL_MAPPINGS[page].startsWith("aurora://")) {
      // Proxy the external URL but show aurora://
      proxyNavigate(AURORA_PROTOCOL_MAPPINGS[page], tabId, url, options);
      return;
    } else {
      // Internal page
      tab.url = url;
      tab.title = page.charAt(0).toUpperCase() + page.slice(1);
      tab.favicon = "🌌";
      showInternalPage(page);
    }
    
    // Update history
    if (options.history !== false) {
      if (tab.history[tab.historyIndex] !== url) {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
        tab.history.push(url);
        tab.historyIndex = tab.history.length - 1;
      }
    }
    
    updateUrlBar(url);
    updateNavigationButtons();
    renderTabs();
    if (options.history !== false) {
      addToHistory(url, tab.title);
    }
    return;
  }
  
  // Handle regular URLs
  url = parseUrl(url);
  proxyNavigate(url, tabId, null, options);
}

function parseUrl(input) {
  // If it looks like a URL, use it
  try {
    return new URL(input).toString();
  } catch (e) {
    // Try adding https://
    try {
      const url = new URL(`https://${input}`);
      if (url.hostname.includes(".")) return url.toString();
    } catch (e2) {
      // Treat as search query
    }
  }
  
  // Use as search query
  return settings.searchEngine.replace("%s", encodeURIComponent(input));
}

async function proxyNavigate(url, tabId = activeTabId, displayUrl = null, options = {}) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Check interceptors
  for (const interceptor of requestInterceptors) {
      try {
          const result = interceptor(url);
          if (result && result.cancel) {
              addConsoleMessage("info", `Navigation to ${url} blocked by extension.`);
              return;
          }
      } catch (e) {
          console.error("Interceptor error:", e);
      }
  }
  
  // OFFLINE MODE CHECK
  if (!navigator.onLine && OfflineManager.enabled) {
      addConsoleMessage("info", "Network offline, checking cache...");
      const offlinePage = await OfflineManager.getPage(url);
      
      if (offlinePage) {
          // Ensure frame exists
          if (!tab.scramjetFrame && scramjet) {
            tab.scramjetFrame = scramjet.createFrame();
            tab.frame = tab.scramjetFrame.frame;
            tab.frame.className = "browser-frame";
            tab.frame.id = "frame-" + tab.id;
            elements.frameContainer.appendChild(tab.frame);
          }
          
          if (tab.frame) {
              // Render offline content
              tab.frame.removeAttribute('src');
              tab.frame.srcdoc = offlinePage.content;
              
              tab.url = displayUrl || url;
              tab.title = offlinePage.title + " (Offline)";
              tab.favicon = "💾";
              
              if (tabId === activeTabId) {
                tab.frame.classList.add("active");
                updateUrlBar(tab.url);
                updateNavigationButtons();
              }
              
              // Hide internal pages
              if (elements.homePage) elements.homePage.classList.add("hidden");
              if (elements.frameContainer) elements.frameContainer.style.display = "";
              
              renderTabs();
              addConsoleMessage("info", "Loaded page from offline cache.");
              return;
          }
      } else {
          // Fall through to try loading anyway, or show error
          addConsoleMessage("warn", "Page not found in offline cache.");
      }
  }
  
  try {
    await registerSW();
  } catch (err) {
    console.error("Failed to register service worker:", err);
    addConsoleMessage("error", `Failed to register service worker: ${err.message}`);
    return;
  }
  
  // Configure transport
  await configureTransport();
  
  // Ensure frame container is visible and accepts input for proxied pages
  if (elements.frameContainer) {
    elements.frameContainer.style.display = "";
    elements.frameContainer.style.pointerEvents = "auto";
    elements.frameContainer.style.zIndex = "1";
  }
  
  // Hide internal pages
  if (elements.homePage) { elements.homePage.classList.add("hidden"); elements.homePage.style.pointerEvents = "none"; }
  if (elements.settingsPage) { elements.settingsPage.classList.add("hidden"); elements.settingsPage.style.pointerEvents = "none"; }
  if (elements.historyPage) { elements.historyPage.classList.add("hidden"); elements.historyPage.style.pointerEvents = "none"; }
  if (elements.bookmarksPage) { elements.bookmarksPage.classList.add("hidden"); elements.bookmarksPage.style.pointerEvents = "none"; }
  if (elements.extensionsPage) { elements.extensionsPage.classList.add("hidden"); elements.extensionsPage.style.pointerEvents = "none"; }
  
  // Create Scramjet frame if not exists
  if (!tab.scramjetFrame && scramjet) {
    tab.scramjetFrame = scramjet.createFrame();
    tab.frame = tab.scramjetFrame.frame;
    tab.frame.className = "browser-frame";
    tab.frame.id = "frame-" + tab.id;
    
    // OPTIMIZATION: Grant full permissions to the iframe for games
    tab.frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen; camera; microphone; midi; gamepad";
    
    elements.frameContainer.appendChild(tab.frame);
    
    // Set up frame event listeners
    setupFrameListeners(tab.frame, tab);
  }
  
  // Navigate the frame using Scramjet
  if (tab.scramjetFrame) {
    tab.scramjetFrame.go(url);
  }
  
  // Update tab state
  tab.url = displayUrl || url;
  tab.title = extractTitle(url);
  tab.favicon = "🌐"; // Default to globe, wait for load to get real icon
  
  // Update history
  if (options.history !== false) {
    const historyUrl = displayUrl || url;
    if (tab.history[tab.historyIndex] !== historyUrl) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(historyUrl);
      tab.historyIndex = tab.history.length - 1;
    }
  }
  
  if (tabId === activeTabId) {
    tab.frame.classList.add("active");
    updateUrlBar(tab.url);
    updateNavigationButtons();
  }
  
  renderTabs();
  if (options.history !== false) {
    addToHistory(tab.url, tab.title);
  }
  addNetworkRequest(url, "document");
}

async function configureTransport(force = false) {
  if (!connection) return;
  
  try {
    const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
    
    if (!force) {
        const currentTransport = await connection.getTransport();
        if (currentTransport === "/epoxy/index.mjs") return;
    }
    
    await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
  } catch (err) {
    console.error("Failed to configure transport:", err);
    addConsoleMessage("error", `Failed to configure transport: ${err.message}`);
  }
}

function setupFrameListeners(frame, tab) {
  frame.addEventListener("load", () => {
    try {
      // Try to get the title from the loaded page
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc) {
        // Inject Bot Evasion & Verification Bypass
        try {
            const script = doc.createElement('script');
            script.textContent = `
                (function() {
                    try {
                        // 1. Navigator Properties: Hide webdriver
                        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                        
                        // 2. Chrome Object
                        if (!window.chrome) window.chrome = {};
                        const chrome = window.chrome;

                        const installProperty = (obj, prop, value) => {
                            if (!obj.hasOwnProperty(prop)) {
                                Object.defineProperty(obj, prop, {
                                    value: value,
                                    writable: true,
                                    enumerable: true,
                                    configurable: true
                                });
                            }
                        };

                        installProperty(chrome, 'runtime', {
                            connect: function() {},
                            sendMessage: function() {},
                            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            getManifest: function() { return { version: "1.0.0" }; },
                            getURL: function(path) { return path; },
                            onMessage: { addListener: function() {}, removeListener: function() {} },
                            onConnect: { addListener: function() {}, removeListener: function() {} },
                            onInstalled: { addListener: function() {}, removeListener: function() {} }
                        });

                        installProperty(chrome, 'loadTimes', function() {
                            return {
                                getLoadTime: () => Date.now() / 1000,
                                getLoadEventEnd: () => Date.now() / 1000,
                                getNavigationType: () => "Other",
                                wasNpnNegotiated: true,
                                npnNegotiatedProtocol: "h2",
                                wasAlternateProtocolAvailable: false,
                                connectionInfo: "h2"
                            };
                        });

                        installProperty(chrome, 'csi', function() {
                            return {
                                pageT: Date.now() / 1000,
                                onloadT: Date.now() / 1000,
                                startE: Date.now() / 1000,
                                tran: 15
                            };
                        });

                        installProperty(chrome, 'app', {
                            isInstalled: false,
                            getDetails: function() { return null; },
                            getIsInstalled: function() { return false; },
                            installState: function() { return "not_installed"; },
                            runningState: function() { return "cannot_run"; },
                            InstallState: {
                                DISABLED: "disabled",
                                INSTALLED: "installed",
                                NOT_INSTALLED: "not_installed"
                            },
                            RunningState: {
                                CANNOT_RUN: "cannot_run",
                                READY_TO_RUN: "ready_to_run",
                                RUNNING: "running"
                            }
                        });

                        installProperty(chrome, 'webstore', {
                            onInstallStageChanged: { addListener: function() {}, removeListener: function() {} },
                            onDownloadProgress: { addListener: function() {}, removeListener: function() {} },
                            install: function() {}
                        });
                        
                        // 3. Permissions API
                        const originalQuery = navigator.permissions?.query;
                        if (originalQuery) {
                            navigator.permissions.query = function(parameters) {
                                if (parameters.name === 'notifications') return Promise.resolve({ state: 'prompt' });
                                return originalQuery.apply(this, arguments);
                            };
                        }
                        
                        // Fix Notification.permission as well
                        if (window.Notification) {
                            try {
                                Object.defineProperty(Notification, 'permission', {
                                    get: () => 'default'
                                });
                            } catch(e) {}
                        }
                        
                        // 4. Plugins
                        Object.defineProperty(navigator, 'plugins', { get: () => {
                            const plugins = [
                                { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                                { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" }
                            ];
                            return plugins;
                        }});
                        
                        // 5. Languages
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                        
                        // 6. User-Agent
                        const ua = navigator.userAgent;
                        if (!ua.includes('Chrome')) {
                            Object.defineProperty(navigator, 'userAgent', {
                                get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            });
                        }
                        
                        // 10. Mouse Events
                        document.addEventListener('mousemove', () => {}, { once: true, passive: true });
                        
                        // 11. Touch Support
                        if (!('ontouchstart' in window)) window.ontouchstart = null;
                        
                        // 12. Connection API
                        if (navigator.connection) {
                            try { Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' }); } catch(e) {}
                        }
                        
                        // 13. Battery API
                        if (!navigator.getBattery) {
                            navigator.getBattery = function() {
                                return Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.85 });
                            };
                        }
                        
                        // 14. Hardware Concurrency
                        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                        
                        // 15. Device Memory
                        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                        
                        // 16. Max Touch Points
                        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
                        
                        // Extra: PostMessage protection
                        if (window.parent !== window) {
                            const originalPostMessage = window.postMessage;
                            window.postMessage = function(message, targetOrigin, transfer) {
                                try { return originalPostMessage.call(this, message, targetOrigin, transfer); } catch(e) {}
                            };
                        }
                        
                        console.debug('[Aurora] Bot evasion loaded');
                    } catch(e) { console.error('[Aurora] Bot evasion error:', e); }
                })();
            `;
            if (doc.head) doc.head.appendChild(script);
            if (doc.documentElement) doc.documentElement.appendChild(script);
        } catch (e) {
            console.warn("Failed to inject bot evasion script:", e);
        }


        if (doc.title) {
          tab.title = doc.title;
        }
        
        // Try to get the real favicon from the page
        const links = doc.querySelectorAll("link[rel*='icon']");
        let iconUrl = null;
        for (const link of links) {
            if (link.href) {
                iconUrl = link.href;
                break;
            }
        }
        
        // Fallback: try default /favicon.ico if no link tag
        if (!iconUrl && doc.location) {
            try {
                // Resolve against the document's current location
                iconUrl = new URL("/favicon.ico", doc.location.href).href;
            } catch (e) {}
        }
        
        if (iconUrl) {
            tab.favicon = `<img src="${iconUrl}" style="width: 16px; height: 16px; vertical-align: middle; border-radius: 2px;" onerror="this.parentElement.innerHTML='🌐'">`;
        }
        
        renderTabs();
      }
      
      // Notify listeners
      tabLoadListeners.forEach(listener => {
          try { listener(tab.id); } catch(e) { console.error("Tab load listener error:", e); }
      });
      
      // Update URL immediately on load
      updateTabUrlFromFrame(frame, tab);
    } catch (e) {
      // Cross-origin restriction - can't access document
    }
    
    addConsoleMessage("info", `Page loaded: ${tab.url}`);
  });
  
  frame.addEventListener("error", (e) => {
    addConsoleMessage("error", `Failed to load: ${tab.url}`);
  });

  // Poll for URL changes every 2 seconds
  if (tab.urlPollingInterval) clearInterval(tab.urlPollingInterval);
  
  const pollInterval = settings.performanceMode ? 5000 : 2000;
  tab.urlPollingInterval = setInterval(() => {
    updateTabUrlFromFrame(frame, tab);
  }, pollInterval);
}

function updateTabUrlFromFrame(frame, tab) {
  if (!frame.contentWindow) return;
  
  // Fix: Do not update URL from frame if we are currently on an internal page
  if (tab.url.startsWith("aurora://")) return;

  try {
    let newUrl = null;
    
    // Try to get the real URL from Scramjet's location wrapper
    if (frame.contentWindow.__scramjet$location && frame.contentWindow.__scramjet$location.href) {
      newUrl = frame.contentWindow.__scramjet$location.href;
    } 
    // Fallback to standard location
    else if (frame.contentWindow.location && frame.contentWindow.location.href) {
      newUrl = frame.contentWindow.location.href;
    }

    // Ignore about:blank or empty
    if (!newUrl || newUrl === "about:blank") return;

    // Clean up Scramjet proxy URLs to show the actual target URL
    if (newUrl.includes("/scramjet/")) {
      const parts = newUrl.split("/scramjet/");
      if (parts.length > 1) {
        try {
          newUrl = decodeURIComponent(parts[1]);
        } catch (e) {
          // Keep original if decoding fails
        }
      }
    }

    // If URL changed
    if (newUrl !== tab.url) {
      
      // Try to update title for history
      try {
        if (frame.contentDocument && frame.contentDocument.title) {
            tab.title = frame.contentDocument.title;
        }
      } catch(e) {}

      // Fix: Update history stack for in-frame navigations
      if (tab.history[tab.historyIndex] !== newUrl) {
          // Branch history if we navigated away from the middle of the stack
          tab.history = tab.history.slice(0, tab.historyIndex + 1);
          tab.history.push(newUrl);
          tab.historyIndex = tab.history.length - 1;
          
          // Add to global history
          addToHistory(newUrl, tab.title);
      }

      tab.url = newUrl;
      
      // Update UI if this is the active tab
      if (tab.id === activeTabId) {
        updateUrlBar(newUrl);
        updateNavigationButtons(); // Update buttons as history changed
        
        // Update bookmark button state based on new URL
        const isBookmarked = bookmarks.some(b => b.url === newUrl);
        if (elements.bookmarkBtn) {
          elements.bookmarkBtn.textContent = isBookmarked ? "★" : "☆";
          elements.bookmarkBtn.classList.toggle("bookmarked", isBookmarked);
        }
      }
    }
  } catch (e) {
    // Ignore cross-origin errors
  }
}

function navigateFromUrlBar() {
  if (!elements.urlBar) return;
  const input = elements.urlBar.value.trim();
  if (!input) return;
  
  // Reconstruct URL with protocol if shown
  let url = input;
  if (elements.urlProtocol.style.display !== "none") {
    url = elements.urlProtocol.textContent + input;
  }
  
  // Check if it starts with aurora://
  if (url.startsWith("aurora://")) {
    window.aurora.navigate(url);
  } else if (!input.includes("://") && !input.includes(".")) {
    // Could be an aurora:// URL shorthand
    if (AURORA_PROTOCOL_MAPPINGS[input]) {
      window.aurora.navigate("aurora://" + input);
    } else {
      window.aurora.navigate(input);
    }
  } else {
    window.aurora.navigate(input);
  }
}

function searchFromHome() {
  if (!elements.homeSearch) return;
  const query = elements.homeSearch.value.trim();
  if (query) window.aurora.navigate(query);
}

function updateUrlBar(url) {
  if (!elements.urlBar || !elements.urlProtocol) return;
  
  if (url.startsWith("aurora://")) {
    elements.urlProtocol.style.display = "none";
    elements.urlBar.value = url.replace("aurora://", "");
  } else {
    elements.urlProtocol.textContent = url.split("://")[0] + "://";
    elements.urlProtocol.style.display = "inline";
    elements.urlBar.value = url.replace(elements.urlProtocol.textContent, "");
  }
  
  // Update bookmark button state
  const isBookmarked = bookmarks.some(b => b.url === url);
  if (elements.bookmarkBtn) {
    elements.bookmarkBtn.textContent = isBookmarked ? "★" : "☆";
    elements.bookmarkBtn.classList.toggle("bookmarked", isBookmarked);
  }
}

function updateNavigationButtons() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  
  if (elements.backBtn) elements.backBtn.disabled = tab.historyIndex <= 0;
  if (elements.forwardBtn) elements.forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
}

function goBack() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.historyIndex <= 0) return;
  
  tab.historyIndex--;
  const url = tab.history[tab.historyIndex];
  
  navigateToHistoryEntry(tab, url);
}

function goForward() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.historyIndex >= tab.history.length - 1) return;
  
  tab.historyIndex++;
  const url = tab.history[tab.historyIndex];
  
  navigateToHistoryEntry(tab, url);
}

function navigateToHistoryEntry(tab, url) {
  // Use the public navigate function so extensions can intercept it (e.g. Offline Mode)
  // Pass history: false to prevent creating a new history entry
  window.aurora.navigate(url, tab.id, { history: false });
}

function refresh() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  
  // Use the public navigate function so extensions can intercept it
  window.aurora.navigate(tab.url, tab.id, { history: false });
}

// ==================== Internal Pages ====================
function showInternalPage(page) {
  // Hide all frames visually and disable them from receiving pointer events
  document.querySelectorAll(".browser-frame").forEach(f => f.classList.remove("active"));
  if (elements.frameContainer) {
    elements.frameContainer.style.display = "none";
    elements.frameContainer.style.pointerEvents = "none";
    elements.frameContainer.style.zIndex = "0";
  }
  
  // Hide all internal pages
  if (elements.homePage) { elements.homePage.classList.add("hidden"); elements.homePage.style.pointerEvents = "none"; }
  if (elements.settingsPage) { elements.settingsPage.classList.add("hidden"); elements.settingsPage.style.pointerEvents = "none"; }
  if (elements.historyPage) { elements.historyPage.classList.add("hidden"); elements.historyPage.style.pointerEvents = "none"; }
  if (elements.bookmarksPage) { elements.bookmarksPage.classList.add("hidden"); elements.bookmarksPage.style.pointerEvents = "none"; }
  if (elements.extensionsPage) { elements.extensionsPage.classList.add("hidden"); elements.extensionsPage.style.pointerEvents = "none"; }
  
  // Show requested page
  switch (page) {
    case "home":
      if (elements.homePage) { elements.homePage.classList.remove("hidden"); elements.homePage.style.pointerEvents = "auto"; }
      break;
    case "settings":
      if (elements.settingsPage) {
        elements.settingsPage.classList.remove("hidden");
        elements.settingsPage.style.pointerEvents = "auto";
        populateSettingsPage();
      }
      break;
    case "history":
      if (elements.historyPage) {
        elements.historyPage.classList.remove("hidden");
        elements.historyPage.style.pointerEvents = "auto";
        renderHistoryPage();
      }
      break;
    case "bookmarks":
      if (elements.bookmarksPage) {
        elements.bookmarksPage.classList.remove("hidden");
        elements.bookmarksPage.style.pointerEvents = "auto";
        renderBookmarksPage();
      }
      break;
    case "extensions":
      if (elements.extensionsPage) {
        elements.extensionsPage.classList.remove("hidden");
        elements.extensionsPage.style.pointerEvents = "auto";
        
        // Fix scrolling and layout
        elements.extensionsPage.style.overflowY = "auto";
        elements.extensionsPage.style.height = "100%";
        elements.extensionsPage.style.display = "flex";
        elements.extensionsPage.style.flexDirection = "column";
        elements.extensionsPage.style.padding = "20px";
        elements.extensionsPage.style.boxSizing = "border-box";

        renderExtensionsPage();
        // Ensure inputs are enabled
        if (elements.extensionUrlInput) elements.extensionUrlInput.disabled = false;
        if (elements.extensionInstall) elements.extensionInstall.disabled = false;
        if (elements.extensionCodeInput) elements.extensionCodeInput.disabled = false;
        if (elements.installCodeBtn) elements.installCodeBtn.disabled = false;
      }
      break;
    case "restart":
      handleRestart();
      break;
    default:
      if (elements.homePage) { elements.homePage.classList.remove("hidden"); elements.homePage.style.pointerEvents = "auto"; }
  }
}

async function handleRestart() {
  const pin = prompt("Enter Admin PIN to restart server:");
  if (!pin) {
    navigate("aurora://home");
    return;
  }

  try {
    const response = await fetch('/api/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });

    const text = await response.text();
    alert(text);

    if (response.ok) {
      // Wait for server to restart then reload
      setTimeout(() => location.reload(), 3000);
    } else {
      navigate("aurora://home");
    }
  } catch (e) {
    alert("Error: " + e.message);
    navigate("aurora://home");
  }
}

function populateSettingsPage() {
  if (elements.searchEngine) elements.searchEngine.value = settings.searchEngine;
  
  if (elements.themeSelect) {
    // Save current selection
    const current = settings.theme;
    
    elements.themeSelect.innerHTML = "";
    
    // Built-in themes
    BUILTIN_THEMES.forEach(theme => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name;
      elements.themeSelect.appendChild(option);
    });
    
    // Custom themes
    Object.keys(customThemes).forEach(id => {
      const theme = customThemes[id];
      const option = document.createElement("option");
      option.value = id;
      option.textContent = `${theme.name} (Custom)`;
      elements.themeSelect.appendChild(option);
    });
    
    elements.themeSelect.value = current;
  }

  if (elements.showBookmarksBar) elements.showBookmarksBar.checked = settings.showBookmarksBar;
  if (elements.performanceMode) elements.performanceMode.checked = settings.performanceMode;
}

// ==================== Bookmarks ====================
function loadBookmarks() {
  try {
    const saved = localStorage.getItem("aurora_bookmarks");
    bookmarks = saved ? JSON.parse(saved) : [
      { name: "Chat", url: "aurora://chat", favicon: "💬" },
      { name: "Post", url: "aurora://post", favicon: "📝" }
    ];
  } catch (e) {
    bookmarks = [];
  }
  renderBookmarksBar();
}

function saveBookmarksToStorage() {
  localStorage.setItem("aurora_bookmarks", JSON.stringify(bookmarks));
  renderBookmarksBar();
}

function renderBookmarksBar() {
  if (!elements.bookmarksList) return;
  
  elements.bookmarksList.innerHTML = "";
  bookmarks.forEach((bookmark, index) => {
    const item = document.createElement("button");
    item.className = "bookmark-item";
    item.innerHTML = `
      <span class="bookmark-favicon">${bookmark.favicon || "📄"}</span>
      <span>${escapeHtml(bookmark.name)}</span>
    `;
    item.addEventListener("click", () => window.aurora.navigate(bookmark.url));
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm(`Delete bookmark "${bookmark.name}"?`)) {
        bookmarks.splice(index, 1);
        saveBookmarksToStorage();
      }
    });
    elements.bookmarksList.appendChild(item);
  });
}

function renderToolbarActions() {
  if (!elements.extensionsToolbar) return;

  // Clear ONLY dynamic actions created by this system
  const existing = elements.extensionsToolbar.querySelectorAll('.ext-toolbar-btn');
  existing.forEach(btn => btn.remove());

  const actionIds = Object.keys(toolbarActions);

  actionIds.forEach(id => {
    const action = toolbarActions[id];
    const btn = document.createElement('button');
    btn.className = 'settings-btn ext-toolbar-btn';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.padding = '6px';
    btn.style.minWidth = '32px';
    btn.style.height = '32px';
    btn.style.marginLeft = '5px';
    btn.style.cursor = 'pointer';
    btn.innerHTML = action.icon;
    btn.title = id;
    btn.onclick = (e) => {
      e.stopPropagation();
      action.onClick();
    };
    elements.extensionsToolbar.appendChild(btn);
  });
  
  // Ensure toolbar is visible if we have actions
  if (actionIds.length > 0 && !settings.performanceMode && !isIncognito) {
      elements.extensionsToolbar.style.display = 'flex';
  }
}

function renderBookmarksPage() {
  const container = document.getElementById("bookmarks-full-list");
  if (!container) return;
  container.innerHTML = "";
  
  if (bookmarks.length === 0) {
    container.innerHTML = '<p class="devtools-info" style="padding: 20px;">No bookmarks yet. Press Ctrl+D to bookmark a page.</p>';
    return;
  }
  
  bookmarks.forEach((bookmark, index) => {
    const item = document.createElement("div");
    item.className = "bookmark-full-item";
    item.innerHTML = `
      <span class="bookmark-full-favicon">${bookmark.favicon || "📄"}</span>
      <div class="bookmark-full-info">
        <div class="bookmark-full-title">${escapeHtml(bookmark.name)}</div>
        <div class="bookmark-full-url">${escapeHtml(bookmark.url)}</div>
      </div>
      <button class="bookmark-delete" title="Delete">×</button>
    `;
    
    item.querySelector(".bookmark-full-title").addEventListener("click", () => {
      window.aurora.navigate(bookmark.url);
    });
    
    item.querySelector(".bookmark-delete").addEventListener("click", () => {
      bookmarks.splice(index, 1);
      saveBookmarksToStorage();
      renderBookmarksPage();
    });
    
    container.appendChild(item);
  });
}

function toggleBookmarkDialog() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  
  // Check if already bookmarked
  const existingIndex = bookmarks.findIndex(b => b.url === tab.url);
  if (existingIndex !== -1) {
    if (confirm(`Remove "${bookmarks[existingIndex].name}" from bookmarks?`)) {
      bookmarks.splice(existingIndex, 1);
      saveBookmarksToStorage();
      updateUrlBar(tab.url);
    }
    return;
  }
  
  // Show dialog
  if (elements.bookmarkDialogOverlay) {
    elements.bookmarkDialogOverlay.classList.remove("hidden");
    if (elements.bookmarkName) elements.bookmarkName.value = tab.title;
    if (elements.bookmarkUrl) elements.bookmarkUrl.value = tab.url;
    if (elements.bookmarkName) elements.bookmarkName.focus();
  }
}

function hideBookmarkDialog() {
  if (elements.bookmarkDialogOverlay) elements.bookmarkDialogOverlay.classList.add("hidden");
}

function saveBookmark() {
  if (!elements.bookmarkName || !elements.bookmarkUrl) return;
  const name = elements.bookmarkName.value.trim();
  const url = elements.bookmarkUrl.value.trim();
  
  if (!name || !url) return;
  
  const tab = tabs.find(t => t.id === activeTabId);
  
  bookmarks.push({
    name: name,
    url: url,
    favicon: tab && tab.favicon ? tab.favicon : (url.startsWith("aurora://") ? "🌌" : "🌐")
  });
  
  saveBookmarksToStorage();
  hideBookmarkDialog();
  
  if (tab) updateUrlBar(tab.url);
}

function clearBookmarks() {
  if (confirm("Are you sure you want to delete all bookmarks?")) {
    bookmarks = [];
    saveBookmarksToStorage();
    renderBookmarksPage();
  }
}

// ==================== History ====================
function loadHistory() {
  try {
    const saved = localStorage.getItem("aurora_history");
    history = saved ? JSON.parse(saved) : [];
  } catch (e) {
    history = [];
  }
}

function saveHistoryToStorage() {
  // Keep last 1000 items
  history = history.slice(0, 1000);
  localStorage.setItem("aurora_history", JSON.stringify(history));
}

function addToHistory(url, title) {
  if (isIncognito) return;
  // Don't add duplicates in a row
  if (history.length > 0 && history[0].url === url) return;
  
  history.unshift({
    url: url,
    title: title,
    timestamp: Date.now()
  });
  
  saveHistoryToStorage();
}

function renderHistoryPage() {
  const container = document.getElementById("history-list");
  if (!container) return;
  container.innerHTML = "";
  
  if (history.length === 0) {
    container.innerHTML = '<p class="devtools-info" style="padding: 20px;">No browsing history yet.</p>';
    return;
  }
  
  history.forEach((item, index) => {
    const historyItem = document.createElement("div");
    historyItem.className = "history-item";
    
    const date = new Date(item.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = date.toLocaleDateString();
    
    historyItem.innerHTML = `
      <span class="history-favicon">${item.url.startsWith("aurora://") ? "🌌" : "🌐"}</span>
      <div class="history-info">
        <div class="history-title">${escapeHtml(item.title)}</div>
        <div class="history-url">${escapeHtml(item.url)}</div>
      </div>
      <span class="history-time">${timeStr}<br>${dateStr}</span>
      <button class="history-delete" title="Delete">×</button>
    `;
    
    historyItem.querySelector(".history-title").addEventListener("click", () => {
      window.aurora.navigate(item.url);
    });
    
    historyItem.querySelector(".history-delete").addEventListener("click", () => {
      history.splice(index, 1);
      saveHistoryToStorage();
      renderHistoryPage();
    });
    
    container.appendChild(historyItem);
  });
}

function clearHistory() {
  if (confirm("Are you sure you want to clear all browsing history?")) {
    history = [];
    saveHistoryToStorage();
    renderHistoryPage();
  }
}

async function clearSiteData() {
  try {
    // Clear Cookies
    const cookies = document.cookie.split(";");
    for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i].trim();
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        
        // Preserve infrastructure cookies
        if (name.toLowerCase().match(/(github|codespace|auth|token|cf_|__host|__secure|wisp|epoxy|bare)/)) {
            continue;
        }

        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
    }

    // Clear Storage (preserving Aurora data)
    localStorage.clear();
    sessionStorage.clear();
    
    // Restore Aurora Data immediately
    saveSettings();
    saveBookmarksToStorage();
    saveHistoryToStorage();
    saveExtensions();

    // Clear Caches (Service Workers)
    if (window.caches) {
        const keys = await window.caches.keys();
        await Promise.all(keys.map(key => window.caches.delete(key)));
    }

    // Clear IndexedDB (if supported)
    if (window.indexedDB && window.indexedDB.databases) {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
            window.indexedDB.deleteDatabase(db.name);
        }
    }
    
    addConsoleMessage("info", "Site data cleared (Cookies, Storage, Cache)");
  } catch (e) {
    console.error("Failed to clear site data:", e);
  }
}

// ==================== Settings ====================
function loadSettings() {
  try {
    const saved = localStorage.getItem("aurora_settings");
    settings = saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    settings = { ...DEFAULT_SETTINGS };
  }
  updateBookmarksBarVisibility();
}

function saveSettings() {
  localStorage.setItem("aurora_settings", JSON.stringify(settings));
}

function loadCustomThemes() {
  try {
    const saved = localStorage.getItem("aurora_custom_themes");
    customThemes = saved ? JSON.parse(saved) : {};
  } catch (e) {
    customThemes = {};
  }
}

function saveCustomThemes() {
  localStorage.setItem("aurora_custom_themes", JSON.stringify(customThemes));
}

function applyTheme() {
  // Safely remove existing theme classes without clearing other classes (like perf-mode or incognito-mode)
  const classes = Array.from(document.body.classList);
  classes.forEach(c => {
    if (c.endsWith('-theme')) document.body.classList.remove(c);
  });

  // Remove custom theme style if exists
  const customStyle = document.getElementById("aurora-custom-theme-style");
  if (customStyle) customStyle.remove();

  if (settings.theme === "dark") {
    // Default, do nothing (or ensure no class)
  } else if (customThemes[settings.theme]) {
    // Apply custom theme
    const theme = customThemes[settings.theme];
    const style = document.createElement("style");
    style.id = "aurora-custom-theme-style";
    style.textContent = theme.css;
    document.head.appendChild(style);
  } else {
    // Built-in theme
    document.body.classList.add(`${settings.theme}-theme`);
  }
}

function injectBuiltinThemes() {
  const styleId = "aurora-builtin-themes";
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    /* Light Theme */
    body.light-theme {
      --bg-primary: #ffffff;
      --bg-secondary: #f0f2f5;
      --bg-tertiary: #e4e6eb;
      --text-primary: #050505;
      --text-secondary: #65676b;
      --border-color: #ced0d4;
      --accent-color: #1b74e4;
      --hover-color: #e4e6eb;
    }
    
    /* Midnight Blue */
    body.midnight-theme {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --border-color: #334155;
      --accent-color: #38bdf8;
      --hover-color: #334155;
    }

    /* Forest Green */
    body.forest-theme {
      --bg-primary: #1a2f1a;
      --bg-secondary: #2f4f2f;
      --bg-tertiary: #3d5d3d;
      --text-primary: #e0ffe0;
      --text-secondary: #a0c0a0;
      --border-color: #3d5d3d;
      --accent-color: #4caf50;
      --hover-color: #3d5d3d;
    }

    /* Sunset Orange */
    body.sunset-theme {
      --bg-primary: #2d1b1b;
      --bg-secondary: #4a2c2c;
      --bg-tertiary: #6d3d3d;
      --text-primary: #ffecd1;
      --text-secondary: #d1a0a0;
      --border-color: #6d3d3d;
      --accent-color: #ff7e5f;
      --hover-color: #6d3d3d;
    }

    /* Deep Ocean */
    body.ocean-theme {
      --bg-primary: #001f3f;
      --bg-secondary: #003366;
      --bg-tertiary: #004080;
      --text-primary: #d0e1f9;
      --text-secondary: #8aa2c9;
      --border-color: #004080;
      --accent-color: #0074d9;
      --hover-color: #004080;
    }

    /* Hacker Green */
    body.hacker-theme {
      --bg-primary: #000000;
      --bg-secondary: #0d0d0d;
      --bg-tertiary: #1a1a1a;
      --text-primary: #00ff00;
      --text-secondary: #00cc00;
      --border-color: #003300;
      --accent-color: #00ff00;
      --hover-color: #003300;
      font-family: 'Courier New', monospace;
    }
  `;
  document.head.appendChild(style);
}

function updateBookmarksBarVisibility() {
  if (elements.bookmarksBar) {
    elements.bookmarksBar.classList.toggle("hidden", !settings.showBookmarksBar);
  }
}

function resetSettings() {
  if (confirm("Are you sure you want to reset all settings to defaults?")) {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applyTheme();
    populateSettingsPage();
    updateBookmarksBarVisibility();
  }
}

// ==================== Extensions ====================
function loadExtensions() {
  try {
    const saved = localStorage.getItem("aurora_extensions");
    extensions = saved ? JSON.parse(saved) : [];
  } catch (e) {
    extensions = [];
  }
}

function saveExtensions() {
  localStorage.setItem("aurora_extensions", JSON.stringify(extensions));
}

async function installExtensionFromUrl() {
  if (!elements.extensionUrlInput) return;
  const url = elements.extensionUrlInput.value.trim();
  if (!url) return;

  // Security Warning
  const warning = "⚠️ SECURITY WARNING ⚠️\n\n" +
                  "You are about to install an extension from a URL.\n" +
                  "Extensions can access all your data, including passwords and browsing history.\n" +
                  "Only install extensions from sources you completely trust.\n\n" +
                  "Do you want to proceed?";
  
  if (!confirm(warning)) {
      return;
  }

  try {
    if (elements.extensionInstall) {
      elements.extensionInstall.textContent = "Installing...";
      elements.extensionInstall.disabled = true;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch extension: ${response.statusText}`);
    const content = await response.text();
    
    const { metadata, code } = parseExtensionFile(content);
    
    if (extensions.some(e => e.id === metadata.id)) {
      if (!confirm(`Extension "${metadata.name}" is already installed. Update it?`)) {
        return;
      }
      extensions = extensions.filter(e => e.id !== metadata.id);
    }

    const extension = {
      id: metadata.id,
      metadata: metadata,
      code: code,
      enabled: true,
      sourceUrl: url,
      installedAt: Date.now()
    };

    extensions.push(extension);
    saveExtensions();
    runExtension(extension);
    
    elements.extensionUrlInput.value = "";
    renderExtensionsPage();
    alert(`Extension "${metadata.name}" installed successfully!`);

  } catch (e) {
    alert(`Error installing extension: ${e.message}`);
  } finally {
    if (elements.extensionInstall) {
      elements.extensionInstall.textContent = "Install";
      elements.extensionInstall.disabled = false;
    }
  }
}

async function installExtensionFromCode() {
  if (!elements.extensionCodeInput) return;
  const codeContent = elements.extensionCodeInput.value.trim();
  
  if (!codeContent) {
    alert("Please paste extension code first.");
    return;
  }

  // Security Warning
  const warning = "⚠️ SECURITY WARNING ⚠️\n\n" +
                  "You are about to install an extension from raw code.\n" +
                  "Extensions can access all your data, including passwords and browsing history.\n" +
                  "Only install extensions if you understand the code or trust the source.\n\n" +
                  "Do you want to proceed?";
  
  if (!confirm(warning)) {
      return;
  }

  try {
    const { metadata, code } = parseExtensionFile(codeContent);
    
    if (extensions.some(e => e.id === metadata.id)) {
      if (!confirm(`Extension "${metadata.name}" is already installed. Update it?`)) {
        return;
      }
      // Remove old version
      extensions = extensions.filter(e => e.id !== metadata.id);
    }

    const extension = {
      id: metadata.id,
      metadata: metadata,
      code: code,
      enabled: true,
      sourceUrl: "pasted-code",
      installedAt: Date.now()
    };

    extensions.push(extension);
    saveExtensions();
    runExtension(extension);
    
    elements.extensionCodeInput.value = "";
    renderExtensionsPage();
    alert(`Extension "${metadata.name}" installed successfully!\n\nPlease refresh the page to ensure it works correctly.`);

  } catch (e) {
    alert(`Error installing extension: ${e.message}`);
  }
}

function parseExtensionFile(content) {
  const metadataMatch = content.match(/\/\*METADATA\*\/([\s\S]*?)\/\*CODE\*\//);
  const codeMatch = content.match(/\/\*CODE\*\/([\s\S]*)/);

  if (!metadataMatch || !codeMatch) {
    throw new Error("Invalid extension format. Missing METADATA or CODE sections.");
  }

  try {
    const metadata = JSON.parse(metadataMatch[1]);
    if (!metadata.id || !metadata.name || !metadata.version) {
      throw new Error("Invalid metadata. Missing id, name, or version.");
    }
    return { metadata, code: codeMatch[1] };
  } catch (e) {
    throw new Error("Failed to parse extension metadata: " + e.message);
  }
}

function runExtension(ext) {
  if (settings.performanceMode) return; // Disable extensions in Game Mode

  const startTime = performance.now();

  try {
    // Execute in global scope using a script tag to ensure access to window
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          console.log("Initializing extension: ${ext.metadata.name}");
          ${ext.code}
        } catch(e) {
          console.error("Extension error [${ext.metadata.name}]:", e);
        }
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    const endTime = performance.now();
    const duration = endTime - startTime;

    if (duration > 50) {
        console.warn(`Extension "${ext.metadata.name}" took ${duration.toFixed(2)}ms to initialize.`);
        checkExtensionLag(ext.metadata.name, duration);
    }

  } catch (e) {
    console.error(`Failed to run extension ${ext.metadata.name}:`, e);
  }
}

function checkExtensionLag(name, duration) {
    if (duration > 200) { // Threshold for "Laggy"
        const action = confirm(
            `⚠️ Performance Alert ⚠️\n\n` +
            `The extension "${name}" is slowing down the browser (took ${duration.toFixed(0)}ms to load).\n\n` +
            `Do you want to disable it to improve performance?`
        );
        
        if (action) {
            const extIndex = extensions.findIndex(e => e.metadata.name === name);
            if (extIndex !== -1) {
                extensions[extIndex].enabled = false;
                saveExtensions();
                alert(`Extension "${name}" disabled. Please reload the page.`);
                window.location.reload();
            }
        }
    }
}

// Global Performance Monitor (FPS Checker)
let lastFrameTime = performance.now();
let frameCount = 0;
let lowFpsCount = 0;

function monitorPerformance() {
    if (settings.performanceMode) return; // Don't monitor in perf mode (it's already optimized)

    const now = performance.now();
    const delta = now - lastFrameTime;
    
    if (delta >= 1000) {
        const fps = frameCount;
        frameCount = 0;
        lastFrameTime = now;

        if (fps < 20 && extensions.some(e => e.enabled)) {
            lowFpsCount++;
            if (lowFpsCount > 5) { // 5 seconds of low FPS
                lowFpsCount = 0;
                const action = confirm(
                    "⚠️ High Lag Detected ⚠️\n\n" +
                    "The browser is running slowly. This might be caused by extensions.\n\n" +
                    "Do you want to enable 'Game / Performance Mode' to disable extensions and speed up?"
                );
                if (action) {
                    settings.performanceMode = true;
                    saveSettings();
                    window.location.reload();
                }
            }
        } else {
            lowFpsCount = 0;
        }
    }
    
    frameCount++;
    requestAnimationFrame(monitorPerformance);
}

// Start monitoring
requestAnimationFrame(monitorPerformance);

function renderExtensionsPage() {
  if (!elements.extensionsPage) return;

  // Inject Tabs if missing
  let tabBar = document.getElementById('ext-tabs');
  if (!tabBar) {
    // Create Header Container
    const header = document.createElement('div');
    header.id = 'extensions-header'; // ID for easy identification
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.marginBottom = '20px';
    header.style.paddingBottom = '15px';
    header.style.borderBottom = '1px solid var(--border-color)';

    const title = document.createElement('h2');
    title.textContent = 'Extensions';
    title.style.margin = '0';
    header.appendChild(title);

    tabBar = document.createElement('div');
    tabBar.id = 'ext-tabs';
    tabBar.style.display = 'flex';
    tabBar.style.gap = '10px';
    
    header.appendChild(tabBar);
    
    // Insert header at top
    if (elements.extensionsPage.firstChild) {
        elements.extensionsPage.insertBefore(header, elements.extensionsPage.firstChild);
    } else {
        elements.extensionsPage.appendChild(header);
    }

    // Remove old h1 if exists
    const oldH1 = elements.extensionsPage.querySelector('h1');
    if (oldH1) oldH1.remove();

    tabBar.innerHTML = `
      <button id="tab-installed-btn" class="settings-btn">My Extensions</button>
      <button id="tab-marketplace-btn" class="settings-btn">Web Store</button>
    `;
    
    document.getElementById('tab-installed-btn').onclick = () => { 
      currentExtensionTab = 'installed'; 
      renderExtensionsPage(); 
    };
    document.getElementById('tab-marketplace-btn').onclick = () => { 
      currentExtensionTab = 'marketplace'; 
      renderExtensionsPage(); 
    };
  }

  // Update Tab Styles
  const btnInstalled = document.getElementById('tab-installed-btn');
  const btnMarketplace = document.getElementById('tab-marketplace-btn');
  if (btnInstalled) {
      const activeStyle = 'background: var(--accent-color); color: #fff; border-color: var(--accent-color);';
      const inactiveStyle = 'background: transparent; color: var(--text-primary); border-color: var(--border-color);';
      btnInstalled.style.cssText = `padding: 8px 16px; border-radius: 20px; cursor: pointer; border: 1px solid; ${currentExtensionTab === 'installed' ? activeStyle : inactiveStyle}`;
  }
  if (btnMarketplace) {
      const activeStyle = 'background: var(--accent-color); color: #fff; border-color: var(--accent-color);';
      const inactiveStyle = 'background: transparent; color: var(--text-primary); border-color: var(--border-color);';
      btnMarketplace.style.cssText = `padding: 8px 16px; border-radius: 20px; cursor: pointer; border: 1px solid; ${currentExtensionTab === 'marketplace' ? activeStyle : inactiveStyle}`;
  }

  // Ensure Lists Exist
  if (!elements.extensionsList) {
      elements.extensionsList = document.createElement('div');
      elements.extensionsList.id = 'extensions-list';
      elements.extensionsList.style.flex = '1';
      elements.extensionsPage.appendChild(elements.extensionsList);
  }
  // Re-attach if lost
  if (!elements.extensionsPage.contains(elements.extensionsList)) {
      elements.extensionsPage.appendChild(elements.extensionsList);
  }

  if (!elements.marketplaceList) {
      elements.marketplaceList = document.createElement('div');
      elements.marketplaceList.id = 'marketplace-list';
      elements.marketplaceList.style.flex = '1';
      elements.extensionsPage.appendChild(elements.marketplaceList);
  }
  if (!elements.extensionsPage.contains(elements.marketplaceList)) {
      elements.extensionsPage.appendChild(elements.marketplaceList);
  }

  // Apply Grid Style to Marketplace List
  elements.marketplaceList.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
  elements.marketplaceList.style.gap = '20px';
  elements.marketplaceList.style.padding = '10px 0';

  // Toggle Visibility
  const header = document.getElementById('extensions-header');
  
  Array.from(elements.extensionsPage.children).forEach(child => {
      // Always show header
      if (child === header) {
          child.style.display = 'flex';
          return;
      }
      
      // Show Marketplace List only in marketplace tab
      if (child === elements.marketplaceList) {
          child.style.display = currentExtensionTab === 'marketplace' ? 'grid' : 'none';
          return;
      }
      
      // Show Extensions List only in installed tab
      if (child === elements.extensionsList) {
          child.style.display = currentExtensionTab === 'installed' ? 'block' : 'none';
          return;
      }
      
      // Hide everything else (manual install forms, etc) when in marketplace
      // Show them when in installed tab
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
      
      child.style.display = currentExtensionTab === 'installed' ? '' : 'none';
  });

  // Render Content
  if (currentExtensionTab === 'installed') {
      renderInstalledExtensions();
  } else {
      if (elements.marketplaceList.children.length === 0) {
        renderMarketplacePage();
      }
  }
}

function renderInstalledExtensions() {
  if (!elements.extensionsList) return;
  
  elements.extensionsList.innerHTML = "";
  
  if (extensions.length === 0) {
    const msg = document.createElement('p');
    msg.className = "devtools-info";
    msg.textContent = "No extensions installed.";
    elements.extensionsList.appendChild(msg);
  } else {
    extensions.forEach(ext => {
      const item = document.createElement("div");
      item.className = "settings-section";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "16px";
      item.style.padding = "16px";
      item.style.background = "var(--bg-secondary)";
      item.style.borderRadius = "8px";
      item.style.border = "1px solid var(--border-color)";
      item.style.marginBottom = "10px";
      
      const icon = ext.metadata.icon || "🧩";
      const isImg = icon.startsWith("data:image");
      
      item.innerHTML = `
        <div style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 24px; background: var(--bg-tertiary); border-radius: 8px;">
          ${isImg ? `<img src="${icon}" style="width: 32px; height: 32px;">` : icon}
        </div>
        <div style="flex: 1; min-width: 0;">
          <h3 style="margin: 0 0 4px 0; font-size: 16px;">${escapeHtml(ext.metadata.name)} <span style="font-size: 12px; color: var(--text-secondary);">v${escapeHtml(ext.metadata.version)}</span></h3>
          <p style="margin: 0; font-size: 13px; color: var(--text-secondary);">${escapeHtml(ext.metadata.description)}</p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
            <input type="checkbox" ${ext.enabled ? "checked" : ""} class="ext-toggle" data-id="${ext.id}">
            Enable
          </label>
          <button class="settings-btn danger ext-delete" data-id="${ext.id}" style="padding: 6px 12px; font-size: 12px;">Delete</button>
        </div>
      `;
      
      item.querySelector(".ext-toggle").addEventListener("change", (e) => {
        toggleExtension(ext.id, e.target.checked);
      });
      
      item.querySelector(".ext-delete").addEventListener("click", () => {
        deleteExtension(ext.id);
      });
      
      elements.extensionsList.appendChild(item);
    });
  }
}

function toggleExtension(id, enabled) {
  const ext = extensions.find(e => e.id === id);
  if (!ext) return;
  
  ext.enabled = enabled;
  saveExtensions();
  
  if (enabled) {
    // Run the extension if enabled
    runExtension(ext);
  } else {
    // Optionally, you can stop the extension's functionality here
    // For example, if it registers any background tasks or listeners
  }
}

function deleteExtension(id) {
  if (!confirm("Are you sure you want to delete this extension?")) return;
  
  extensions = extensions.filter(e => e.id !== id);
  saveExtensions();
  renderExtensionsPage();
}

// MARK: Marketplace functions

async function renderMarketplacePage() {
  if (!elements.marketplaceList) return;
  const indexUrl = (elements.marketplaceIndexUrl && elements.marketplaceIndexUrl.value.trim()) || DEFAULT_MARKETPLACE_INDEX;
  elements.marketplaceList.innerHTML = `<div class="devtools-info">Loading marketplace...</div>`;
  try {
    const data = await fetchMarketplaceIndex(indexUrl);
    renderMarketplaceItems(data, indexUrl);
  } catch (err) {
    elements.marketplaceList.innerHTML = `<div class="devtools-info">Failed to load marketplace: ${escapeHtml(String(err.message || err))}</div>`;
    addConsoleMessage("error", `Marketplace load failed: ${err.message || err}`);
  }
}

async function fetchMarketplaceIndex(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch marketplace index");
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("Invalid marketplace index format (expected array)");
  return json;
}

function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = a.split('.').map(n => parseInt(n)||0);
  const pb = b.split('.').map(n => parseInt(n)||0);
  const len = Math.max(pa.length, pb.length);
  for (let i=0;i<len;i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function renderMarketplaceItems(items, indexUrl) {
  if (!elements.marketplaceList) return;
  elements.marketplaceList.innerHTML = "";
  if (!items || items.length === 0) {
    elements.marketplaceList.style.display = 'block'; // Fallback to block for message
    elements.marketplaceList.innerHTML = '<p class="devtools-info">No extensions in marketplace.</p>';
    return;
  }

  // Ensure grid layout
  elements.marketplaceList.style.display = 'grid';

  items.forEach(item => {
    const container = document.createElement("div");
    container.className = "marketplace-item";
    // Card styling
    container.style.cssText = `
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 15px;
        transition: transform 0.2s, box-shadow 0.2s;
        height: 100%;
    `;
    container.onmouseenter = () => {
        container.style.transform = 'translateY(-2px)';
        container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    };
    container.onmouseleave = () => {
        container.style.transform = 'none';
        container.style.boxShadow = 'none';
    };

    const installed = extensions.find(e => e.id === item.id);
    const updateAvailable = installed && compareVersions(item.version, installed.metadata.version) === 1;

    container.innerHTML = `
      <div style="display:flex; align-items:center; gap:15px;">
        <div style="width:56px; height:56px; display:flex; align-items: center; justify-content: center; font-size:32px; background: var(--bg-tertiary); border-radius: 12px;">
            ${item.icon||"🧩"}
        </div>
        <div style="flex:1; min-width:0;">
            <div style="font-weight:700; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.name)}</div>
            <div style="font-size:12px; color:var(--text-secondary);">v${escapeHtml(item.version)}</div>
        </div>
      </div>
      
      <div style="font-size:13px; color:var(--text-secondary); flex:1; line-height:1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;">
        ${escapeHtml(item.description || "No description available.")}
      </div>
      
      <div style="margin-top:auto; display:flex; align-items: center; justify-content: space-between;">
        ${installed && updateAvailable ? `<span style="color:var(--accent-color); font-size:12px; font-weight:bold;">Update Available</span>` : '<span></span>'}
        
        <button class="settings-btn marketplace-install" data-url="${escapeHtml(item.fileUrl || item.url || item.file || "")}" 
            style="${installed && !updateAvailable ? 'background:var(--bg-tertiary); color:var(--text-secondary);' : 'background:var(--accent-color); color:#fff; border:none;'}">
          ${installed ? (updateAvailable ? "Update" : "Installed") : "Add to Aurora"}
        </button>
      </div>
    `;

    const btn = container.querySelector(".marketplace-install");
    if (btn && (!installed || updateAvailable)) {
      btn.addEventListener("click", async (e) => {
        let fileUrl = btn.dataset.url;
        if (!fileUrl) {
          addConsoleMessage("error", "Marketplace entry has no file URL");
          return;
        }
        
        // Resolve relative URLs against index URL
        try {
           let baseUrl = indexUrl;
           // Explicitly handle index.json removal as requested to get the base directory
           if (baseUrl.toLowerCase().endsWith('/index.json')) {
               baseUrl = baseUrl.substring(0, baseUrl.length - 'index.json'.length);
           } else {
               // Fallback to directory of URL if not ending in index.json
               baseUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
           }

           // Remove leading slash from fileUrl to make it relative to baseUrl
           // e.g. /files/AdBlock.txt -> files/AdBlock.txt
           const relativePath = fileUrl.startsWith('/') ? fileUrl.substring(1) : fileUrl;
           
           // Handle absolute URLs in fileUrl
           if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
               // do nothing, it's absolute
           } else {
               fileUrl = new URL(relativePath, baseUrl).href;
           }
           
           addConsoleMessage("info", `Downloading extension from: ${fileUrl}`);
        } catch(e) {
           console.error("URL resolution error:", e);
        }

        btn.disabled = true;
        btn.textContent = installed ? "Updating..." : "Adding...";
        try {
          await installMarketplaceUrl(fileUrl);
          addConsoleMessage("info", `${item.name} installed/updated`);
          renderExtensionsPage(); // refresh installed list
          renderMarketplacePage(); // refresh marketplace status
          alert(`Extension "${item.name}" installed successfully!\n\nPlease refresh the page to ensure it works correctly.`);
        } catch (err) {
          addConsoleMessage("error", `Install failed: ${err.message}`);
          alert(`Install failed: ${err.message}`);
          btn.disabled = false;
          btn.textContent = installed ? "Update" : "Add to Aurora";
        }
      });
    } else if (btn) {
        btn.disabled = true;
    }

    elements.marketplaceList.appendChild(container);
  });
}

// ==================== DevTools ====================
function setupDevToolsUI() {
  const resizeHandle = document.getElementById("devtools-resize");
  const inspectBtn = document.getElementById("inspect-btn");
  
  // Resize logic
  if (resizeHandle) {
    let isResizing = false;
    let startY, startHeight;
    
    resizeHandle.addEventListener("mousedown", (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = elements.devtoolsPanel.offsetHeight;
      document.body.style.cursor = "ns-resize";
      if (elements.frameContainer) elements.frameContainer.style.pointerEvents = "none";
    });
    
    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const delta = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(window.innerHeight - 100, startHeight + delta));
      elements.devtoolsPanel.style.height = newHeight + "px";
      if (elements.mainContent) elements.mainContent.style.marginBottom = newHeight + "px";
      devtoolsHeight = newHeight;
    });
    
    document.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = "";
        if (elements.frameContainer) elements.frameContainer.style.pointerEvents = "";
      }
    });
  }
  
  // Inspect button
  if (inspectBtn) {
    inspectBtn.addEventListener("click", () => toggleInspectMode());
  }
}

function toggleInspectMode(active) {
  isInspecting = active !== undefined ? active : !isInspecting;
  const inspectBtn = document.getElementById("inspect-btn");
  
  if (inspectBtn) {
    inspectBtn.classList.toggle("active", isInspecting);
  }
  
  if (isInspecting) {
    addConsoleMessage("info", "Inspect mode active. Click to inspect.");
    // Add overlay div to capture clicks over the iframe
    let overlay = document.getElementById("inspect-overlay");
    if (!overlay && elements.frameContainer) {
        overlay = document.createElement("div");
        overlay.id = "inspect-overlay";
        overlay.style.cssText = "position:absolute; top:0; left:0; right:0; bottom:0; z-index:10000; cursor:crosshair;";
        elements.frameContainer.appendChild(overlay);
        
        overlay.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleInspectMode(false);
            toggleDevTools(true);
            switchDevToolsTab("elements");
            addConsoleMessage("info", "Opened Elements panel.");
        });
    }
  } else {
    const overlay = document.getElementById("inspect-overlay");
    if (overlay) overlay.remove();
  }
}

function toggleDevTools(show = null) {
  devtoolsOpen = show !== null ? show : !devtoolsOpen;
  
  // Ensure elements exist
  if (!elements.devtoolsPanel) {
      elements.devtoolsPanel = document.getElementById("devtools-panel");
      if (!elements.devtoolsPanel) return; // Can't open if it doesn't exist
  }

  elements.devtoolsPanel.classList.toggle("hidden", !devtoolsOpen);
  
  if (devtoolsOpen) {
    // Adjust main content height
    if (elements.mainContent) elements.mainContent.style.marginBottom = devtoolsHeight + "px";
    elements.devtoolsPanel.style.height = devtoolsHeight + "px";
    
    // Determine which tab to show
    let activeTab = document.querySelector(".devtools-tab.active");
    let panelId = activeTab ? activeTab.dataset.panel : "elements";
    
    // Try to switch, if it fails, fallback to console
    if (!switchDevToolsTab(panelId)) {
        console.warn(`Failed to open panel ${panelId}, falling back to console`);
        switchDevToolsTab("console");
    }
  } else {
    if (elements.mainContent) elements.mainContent.style.marginBottom = "0";
  }
}

function switchDevToolsTab(panelId) {
  const panels = document.querySelectorAll(".devtools-panel");
  let targetPanel = null;

  // 1. Hide all panels
  panels.forEach(panel => {
    panel.style.display = "none";
    panel.classList.remove("active");
    
    // Check if this is the one we want
    if (panel.id === panelId || panel.id === `devtools-${panelId}`) {
        targetPanel = panel;
    }
  });
  
  // 2. Show target panel
  if (targetPanel) {
    targetPanel.style.display = "block";
    targetPanel.classList.add("active"); // CSS might rely on this

    // 3. Render content
    try {
        if (panelId === "elements" || targetPanel.id.includes("elements")) {
            renderDevToolsContent();
        } else if (panelId === "console" || targetPanel.id.includes("console")) {
            renderConsoleOutput();
        } else if (panelId === "network" || targetPanel.id.includes("network")) {
            renderNetworkList();
        }
    } catch (e) {
        console.error("Error rendering devtools panel:", e);
        targetPanel.innerHTML = `<div class="devtools-info error">Error rendering panel: ${e.message}</div>`;
    }
    
    // 4. Update Tab UI
    document.querySelectorAll(".devtools-tab").forEach(tab => {
        if (tab.dataset.panel === panelId) tab.classList.add("active");
        else tab.classList.remove("active");
    });

    return true;
  } else {
      console.warn(`DevTools panel '${panelId}' not found in DOM.`);
      return false;
  }
}

function renderDevToolsContent() {
  // Elements panel
  const domTree = document.getElementById("dom-tree");
  if (!domTree) {
      console.error("DevTools: #dom-tree not found");
      return;
  }
  
  // Clone to remove old listeners
  const newDomTree = domTree.cloneNode(false);
  newDomTree.id = "dom-tree"; // Critical: preserve ID
  
  // Safety check before replacing
  if (domTree.parentNode) {
      domTree.parentNode.replaceChild(newDomTree, domTree);
  } else {
      return; // Should not happen if getElementById worked
  }
  
  const tab = tabs.find(t => t.id === activeTabId);
  
  if (tab && tab.frame) {
    try {
      // Accessing contentDocument should work for same-origin (proxied) frames
      // Wrap in try-catch for cross-origin protection
      let doc = null;
      try {
          // Try standard access
          doc = tab.frame.contentDocument || (tab.frame.contentWindow ? tab.frame.contentWindow.document : null);
      } catch(e) {
          console.warn("DevTools: Cross-origin access blocked", e);
      }

      if (doc && doc.documentElement) {
        // Render the tree
        const html = renderDomNode(doc.documentElement);
        if (html) {
            newDomTree.innerHTML = html;
        } else {
            newDomTree.innerHTML = '<div class="devtools-info">Document is empty.</div>';
        }
        
        // Add interaction
        newDomTree.addEventListener('click', (e) => {
            const nodeEl = e.target.closest('.dom-node');
            if (nodeEl) {
                newDomTree.querySelectorAll('.dom-node.selected').forEach(el => el.classList.remove('selected'));
                nodeEl.classList.add('selected');
            }
        });
        
        // Add Edit on Double Click
        newDomTree.addEventListener('dblclick', (e) => {
            const nodeEl = e.target.closest('.dom-node');
            if (nodeEl) {
                const path = nodeEl.dataset.path;
                editNodeHtml(doc.documentElement, path);
            }
        });
      } else {
        newDomTree.innerHTML = '<p class="devtools-info">Document not accessible (Cross-Origin Protected).</p>';
        // Add a retry button
        const retryBtn = document.createElement('button');
        retryBtn.className = "devtools-btn";
        retryBtn.textContent = "Retry / Force Refresh";
        retryBtn.style.marginTop = "10px";
        retryBtn.onclick = () => renderDevToolsContent();
        newDomTree.appendChild(retryBtn);
      }
    } catch (e) {
      newDomTree.innerHTML = `<p class="devtools-info">Cannot inspect frame content: ${e.message}</p>`;
    }
  } else {
    newDomTree.innerHTML = '<p class="devtools-info">No page loaded.</p>';
  }
}

function getNodeFromPath(root, path) {
    if (path === "root") return root;
    const indices = path.replace("root,", "").split(",").map(Number);
    let current = root;
    for (const i of indices) {
        // Use children to match renderDomNode logic
        if (!current || !current.children || !current.children[i]) return null;
        current = current.children[i];
    }
    return current;
}

function editNodeHtml(root, path) {
    const node = getNodeFromPath(root, path);
    if (!node) return;
    
    // Create a simple modal for editing
    const currentHtml = node.outerHTML;
    
    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.7); z-index: 20000;
        display: flex; align-items: center; justify-content: center;
    `;
    
    const modal = document.createElement('div');
    modal.style.cssText = `
        background: var(--bg-secondary); width: 600px; height: 400px;
        border-radius: 8px; display: flex; flex-direction: column;
        border: 1px solid var(--border-color); box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    `;
    
    const header = document.createElement('div');
    header.style.cssText = "padding: 10px 15px; border-bottom: 1px solid var(--border-color); font-weight: bold; display: flex; justify-content: space-between; color: var(--text-primary);";
    header.innerHTML = `<span>Edit HTML</span><span style="cursor:pointer;" id="close-edit">×</span>`;
    
    const textarea = document.createElement('textarea');
    textarea.style.cssText = "flex: 1; background: var(--bg-primary); color: var(--text-primary); border: none; padding: 10px; font-family: monospace; resize: none; outline: none;";
    textarea.value = currentHtml;
    
    const footer = document.createElement('div');
    footer.style.cssText = "padding: 10px 15px; border-top: 1px solid var(--border-color); text-align: right;";
    
    const saveBtn = document.createElement('button');
    saveBtn.textContent = "Save";
    saveBtn.className = "settings-btn primary";
    saveBtn.onclick = () => {
        try {
            node.outerHTML = textarea.value;
            overlay.remove();
            renderDevToolsContent(); // Refresh tree
            addConsoleMessage("info", "HTML updated successfully.");
        } catch(e) {
            alert("Invalid HTML: " + e.message);
        }
    };
    
    footer.appendChild(saveBtn);
    modal.appendChild(header);
    modal.appendChild(textarea);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    header.querySelector('#close-edit').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
}

function renderDomNode(node, depth = 0, path = "root") {
  if (!node || depth > 8) return "";
  
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ? node.textContent.trim() : "";
    if (text) return `<div class="dom-node text-node" data-path="${path}">"${escapeHtml(text.substring(0, 50))}..."</div>`;
    return "";
  }
  
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  
  const tagName = node.tagName.toLowerCase();
  let attrs = "";
  
  if (node.attributes) {
      for (const attr of node.attributes) {
        const val = attr.value || "";
        attrs += ` <span class="attr-name">${attr.name}</span>=<span class="attr-value">"${escapeHtml(val.substring(0, 30))}"</span>`;
      }
  }
  
  let html = `<div class="dom-node element-node" data-path="${path}" style="padding-left: ${depth > 0 ? 10 : 0}px">
    <span class="tag-string">&lt;<span class="tag-name">${tagName}</span>${attrs}&gt;</span>`;
  
  if (node.children.length > 0) {
    if (depth < 3) {
        html += '<div class="children">';
        for (let i = 0; i < node.children.length; i++) {
            html += renderDomNode(node.children[i], depth + 1, path + "," + i);
        }
        html += '</div>';
    } else {
        html += `<span class="ellipsis">...</span>`;
    }
  } else {
      const text = node.textContent.trim();
      if (text) html += `<span class="text-content">${escapeHtml(text.substring(0, 50))}</span>`;
  }
  
  html += `<span class="tag-string">&lt;/<span class="tag-name">${tagName}</span>&gt;</span></div>`;
  return html;
}

function addConsoleMessage(type, message) {
  // PERFORMANCE: Stop logging if mode is active (unless it's an error)
  if (settings.performanceMode && type !== 'error') return;

  consoleMessages.push({ type, message, timestamp: Date.now() });
  
  // Limit memory usage
  if (consoleMessages.length > 500) {
      consoleMessages.shift();
  }
  
  renderConsoleOutput();
}

function renderConsoleOutput() {
  if (!elements.consoleOutput) return;
  
  // Ensure container has proper styling to prevent layout breakage
  if (!elements.consoleOutput.style.overflowY) {
      elements.consoleOutput.style.overflowY = "auto";
      elements.consoleOutput.style.height = "100%";
      elements.consoleOutput.style.display = "flex";
      elements.consoleOutput.style.flexDirection = "column";
  }

  elements.consoleOutput.innerHTML = consoleMessages.map(msg => `
    <div class="console-message ${msg.type}" style="padding: 4px 8px; border-bottom: 1px solid var(--border-color); font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all;">
      <span>${escapeHtml(typeof msg.message === 'object' ? JSON.stringify(msg.message) : String(msg.message))}</span>
    </div>
  `).join("");
  
  elements.consoleOutput.scrollTop = elements.consoleOutput.scrollHeight;
}

function executeConsoleCommand() {
  if (!elements.consoleInput) return;
  const command = elements.consoleInput.value.trim();
  if (!command) return;
  
  addConsoleMessage("log", `> ${command}`);
  
  try {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.frame) {
      try {
        const result = tab.frame.contentWindow.eval(command);
        addConsoleMessage("log", String(result));
      } catch (e) {
        addConsoleMessage("error", `Cross-origin evaluation not allowed: ${e.message}`);
      }
    } else {
      const result = eval(command);
      addConsoleMessage("log", String(result));
    }
  } catch (e) {
    addConsoleMessage("error", e.message);
  }
  
  elements.consoleInput.value = "";
}

function addNetworkRequest(url, type, status = 200, size = "-", time = "-") {
  // PERFORMANCE: Stop network logging completely in performance mode
  if (settings.performanceMode) return;

  networkRequests.push({
    url: url,
    type: type,
    status: status,
    size: size,
    time: time,
    timestamp: Date.now()
  });
  
  if (networkRequests.length > 500) {
      networkRequests.shift();
  }

  renderNetworkList();
}

function renderNetworkList() {
  if (!elements.networkList) return;
  
  elements.networkList.innerHTML = networkRequests.map(req => `
    <div class="network-item">
      <span class="network-col" title="${escapeHtml(req.url)}">${escapeHtml(extractFileName(req.url))}</span>
      <span class="network-col">${req.status}</span>
      <span class="network-col">${req.type}</span>
      <span class="network-col">${req.size}</span>
      <span class="network-col">${req.time}</span>
    </div>
  `).join("");
}

function clearNetworkLog() {
  const preserve = document.getElementById("preserve-log");
  if (!preserve || !preserve.checked) {
    networkRequests = [];
    renderNetworkList();
  }
}

function showStorageContent(type) {
  document.querySelectorAll(".app-item").forEach(i => i.classList.remove("active"));
  const activeItem = document.querySelector(`.app-item[data-type="${type}"]`);
  if (activeItem) activeItem.classList.add("active");
  
  const content = document.getElementById("application-content");
   if (!content) return;
  
  let html = `<table style="width: 100%; font-size: 12px; border-collapse: collapse;">
    <tr style="text-align: left; border-bottom: 1px solid var(--border-color);">
      <th style="padding: 4px;">Key</th>
      <th style="padding: 4px;">Value</th>
    </tr>`;
  
  try {
    const tab = tabs.find(t => t.id === activeTabId);
    
    if (tab && tab.frame) {
      // Try to access contentWindow safely
      let win;
      try {
          win = tab.frame.contentWindow;
          // Access a property to trigger security check immediately
          const test = win.location.href; 
      } catch(e) {
          throw new Error("Cross-origin frame access blocked.");
      }
      
      if (type === "localStorage") {
        try {
          // Check if storage is available
          if (!win.localStorage) throw new Error("localStorage not available");
          
          const storage = win.localStorage;
          if (storage.length === 0) {
             html += `<tr><td colspan="2" style="padding: 4px; color: var(--text-secondary);">No items in localStorage</td></tr>`;
          } else {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                const value = storage.getItem(key);
                html += `<tr><td style="padding: 4px; font-weight:bold;">${escapeHtml(key)}</td><td style="padding: 4px; word-break:break-all;">${escapeHtml(value ? value.substring(0, 200) : "")}</td></tr>`;
              }
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px; color: #ff6b6b;">Access denied to localStorage: ${e.message}</td></tr>`;
        }
      } else if (type === "sessionStorage") {
        try {
          if (!win.sessionStorage) throw new Error("sessionStorage not available");
          const storage = win.sessionStorage;
          if (storage.length === 0) {
             html += `<tr><td colspan="2" style="padding: 4px; color: var(--text-secondary);">No items in sessionStorage</td></tr>`;
          } else {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                const value = storage.getItem(key);
                html += `<tr><td style="padding: 4px; font-weight:bold;">${escapeHtml(key)}</td><td style="padding: 4px; word-break:break-all;">${escapeHtml(value ? value.substring(0, 200) : "")}</td></tr>`;
              }
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px; color: #ff6b6b;">Access denied to sessionStorage: ${e.message}</td></tr>`;
        }
      } else if (type === "cookies") {
        try {
          // Try accessing document.cookie
          const doc = tab.frame.contentDocument || win.document;
          const cookieStr = doc.cookie;
          
          if (cookieStr) {
            const cookies = cookieStr.split(';');
            cookies.forEach(c => {
              const parts = c.trim().split('=');
              const key = parts[0];
              const value = parts.slice(1).join('=');
              html += `<tr><td style="padding: 4px; font-weight:bold;">${escapeHtml(key)}</td><td style="padding: 4px; word-break:break-all;">${escapeHtml(value ? value.substring(0, 200) : "")}</td></tr>`;
            });
          } else {
             html += `<tr><td colspan="2" style="padding: 4px; color: var(--text-secondary);">No cookies found</td></tr>`;
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px; color: #ff6b6b;">Access denied to cookies: ${e.message}</td></tr>`;
        }
      }
    } else {
      html += `<tr><td colspan="2" style="padding: 4px;">No active frame</td></tr>`;
    }
  } catch (e) {
    html = `<p class="devtools-info">Cannot access storage: ${e.message}</p>`;
  }
  
  html += '</table>';
  content.innerHTML = html;
}

// ==================== Menus ====================
function handleContextMenu(e) {
  e.preventDefault();
  
  const menu = document.getElementById("context-menu");
  if (!menu) return;
  
  // Check for incognito extension
  const incognitoItem = menu.querySelector('[data-action="incognito"]');
  if (incognitoItem) {
      const hasIncognito = extensions.some(e => 
          e.enabled && (e.id === "incognito" || e.metadata.name.toLowerCase().includes("incognito"))
      );
      incognitoItem.style.display = hasIncognito ? "block" : "none";
  }

  // Position menu
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.classList.remove("hidden");
  
  // Add menu item actions
  menu.querySelectorAll(".menu-item").forEach(item => {
    item.onclick = () => handleMainMenuAction(item.dataset.action);
  });
}

function toggleMainMenu() {
  const menu = document.getElementById("main-menu");
  if (menu) {
    // Check for incognito extension
    const incognitoItem = menu.querySelector('[data-action="file-incognito"]');
    if (incognitoItem) {
        const hasIncognito = extensions.some(e => 
            e.enabled && (e.id === "incognito" || e.metadata.name.toLowerCase().includes("incognito"))
        );
        incognitoItem.style.display = hasIncognito ? "flex" : "none";
    }

    menu.classList.toggle("hidden");
  }
}

function hideMenus() {
  const menu = document.getElementById("main-menu");
  if (menu) {
    menu.classList.add("hidden");
  }
  
  const contextMenu = document.getElementById("context-menu");
  if (contextMenu) {
    contextMenu.classList.add("hidden");
  }
}

function handleContextMenuAction(action) {
  switch(action) {
    case "reload":
      window.aurora.refresh();
      break;
    case "close":
      if (activeTabId) closeTab(activeTabId);
      break;
    case "new_tab":
      createTab("aurora://home", "New Tab");
      break;
    case "incognito":
      window.aurora.toggleIncognito();
      break;
    case "settings":
      window.aurora.navigate("aurora://settings");
      break;
    case "help":
      window.aurora.navigate("https://example.com/help");
      break;
    default:
      console.warn("Unknown context menu action:", action);
  }
}

function handleMainMenuAction(action) {
  switch(action) {
    case "file-new":
      createTab("aurora://home", "New Tab");
      break;
    case "file-close":
      if (activeTabId) closeTab(activeTabId);
      break;
    case "file-incognito":
      window.aurora.toggleIncognito();
      break;
    case "edit-undo":
      document.execCommand("undo");
      break;
    case "edit-redo":
      document.execCommand("redo");
      break;
    case "view-reload":
      window.aurora.refresh();
      break;
    case "view-home":
      window.aurora.navigate("aurora://home");
      break;
    case "settings":
      window.aurora.navigate("aurora://settings");
      break;
    case "help":
      window.aurora.navigate("https://example.com/help");
      break;
    case "devtools":
      toggleDevTools();
      break;
    case "about":
      alert("Aurora Browser v1.1.0\n\nA sophisticated web proxy browser built on Scramjet technology.\n\nCopyright 2025 Firewall Freedom by Sirco");
      break;
    default:
      console.warn("Unknown menu action:", action);
  }
}

async function installMarketplaceUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch extension file (${res.status})`);
  const content = await res.text();
  const { metadata, code } = parseExtensionFile(content);

  if (extensions.some(e => e.id === metadata.id)) {
    extensions = extensions.filter(e => e.id !== metadata.id);
  }

  const extension = {
    id: metadata.id,
    metadata: metadata,
    code: code,
    enabled: true,
    sourceUrl: url,
    installedAt: Date.now()
  };

  extensions.push(extension);
  saveExtensions();
  try { runExtension(extension); } catch (e) { console.error(e); }
  renderExtensionsPage();
}

// Ensure registerSW exists if not loaded from register-sw.js
if (typeof registerSW === 'undefined') {
  window.registerSW = async function() {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('/sw.js');
    }
  };
}
