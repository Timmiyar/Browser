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
let networkRequests = [];
let consoleMessages = [];
let currentExtensionTab = 'installed';
let isIncognito = false;
let preIncognitoSnapshot = null; // Store main session data

// Extension hooks
let requestInterceptors = [];
let tabLoadListeners = [];

// ==================== DOM Elements ====================
const elements = {};

// ==================== Initialization ====================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    injectBuiltinThemes(); // Inject CSS for built-in themes
    initializeElements();
    loadSettings();
    loadBookmarks();
    loadHistory();
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
      registerTheme: (id, name, css) => {
        customThemes[id] = { name, css };
        // Refresh selector if settings page is open
        if (elements.settingsPage && !elements.settingsPage.classList.contains("hidden")) {
            populateSettingsPage();
        }
        // Re-apply if this is the active theme
        if (settings.theme === id) {
            applyTheme();
        }
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
            // We only clear Cookies/LS/SS to preserve heavy data like IDB/Cache if desired, 
            // but for true isolation we should clear cookies/storage.
            localStorage.clear();
            sessionStorage.clear();
            
            const cookies = document.cookie.split(";");
            for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i];
                const eqPos = cookie.indexOf("=");
                const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
            }
            
            // Restore Aurora settings immediately so the browser still works
            saveSettings();
            saveBookmarksToStorage();
            saveHistoryToStorage();
            saveExtensions();

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
                const cookie = cookies[i];
                const eqPos = cookie.indexOf("=");
                const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
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
                
                // Re-save Aurora state to ensure any bookmarks/settings changed during incognito are kept
                // (If you want strict incognito where settings revert, remove these lines)
                saveSettings();
                saveBookmarksToStorage();
                saveHistoryToStorage();
                saveExtensions();
                
                preIncognitoSnapshot = null;
                addConsoleMessage("info", "Main session restored.");
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
        applyPerformanceMode
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
  elements.themeSelect = document.getElementById("theme-select");
  elements.showBookmarksBar = document.getElementById("show-bookmarks-bar");
  
  // Inject Performance Setting
  if (!document.getElementById("performance-mode") && elements.settingsPage) {
      const container = document.createElement("div");
      container.className = "settings-section";
      container.innerHTML = `
        <h3>Performance</h3>
        <label class="setting-item">
            <input type="checkbox" id="performance-mode">
            <span>Enable Game / Focus Mode</span>
        </label>
        <p class="setting-desc">Significantly improves speed by disabling background logs, UI effects, and prioritizing game content. Recommended for gaming.</p>
      `;
      // Insert before the Danger Zone or at the end
      const dangerZone = elements.settingsPage.querySelector(".danger-zone");
      if (dangerZone) {
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
        applyPerformanceMode();
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

function applyPerformanceMode() {
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
              border-radius: 0 !important;
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
              will-change: transform;
          }
      `;
      document.head.appendChild(style);

      // 1. Enforce Single Tab
      if (tabs.length > 1) {
          const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];
          // Close others
          tabs = [activeTab];
          activeTabId = activeTab.id;
          
          // Remove other frames from DOM
          const frames = document.querySelectorAll('.browser-frame');
          frames.forEach(f => {
              if (f.id !== 'frame-' + activeTab.id) f.remove();
          });
          
          renderTabs();
      }
      
      // 2. Disable Extensions (Clear hooks)
      requestInterceptors = [];
      tabLoadListeners = [];
      
      // 3. Clear Logs
      consoleMessages = [];
      networkRequests = [];
      renderConsoleOutput();
      renderNetworkList();
      
      // 4. Slow polling
      tabs.forEach(tab => {
          if (tab.urlPollingInterval) {
              clearInterval(tab.urlPollingInterval);
              tab.urlPollingInterval = setInterval(() => {
                  if (tab.frame) updateTabUrlFromFrame(tab.frame, tab);
              }, 5000);
          }
      });

      // Force one message
      consoleMessages.push({ type: "info", message: "Game Mode Active: Single tab, extensions disabled, UI optimized.", timestamp: Date.now() });
      renderConsoleOutput();

  } else {
      document.body.classList.remove('perf-mode');
      
      // Restore polling
      tabs.forEach(tab => {
          if (tab.urlPollingInterval) {
              clearInterval(tab.urlPollingInterval);
              tab.urlPollingInterval = setInterval(() => {
                  if (tab.frame) updateTabUrlFromFrame(tab.frame, tab);
              }, 2000);
          }
      });
      
      // Restore extensions
      requestInterceptors = [];
      tabLoadListeners = [];
      extensions.forEach(ext => {
        if (ext.enabled) runExtension(ext);
      });
      
      addConsoleMessage("info", "Game Mode Disabled.");
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
function navigate(input, tabId = activeTabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  
  let url = input.trim();
  
  // Parse aurora:// URLs
  if (url.startsWith("aurora://")) {
    const page = url.replace("aurora://", "");
    
    // Check if it maps to an external URL
    if (AURORA_PROTOCOL_MAPPINGS[page] && !AURORA_PROTOCOL_MAPPINGS[page].startsWith("aurora://")) {
      // Proxy the external URL but show aurora://
      proxyNavigate(AURORA_PROTOCOL_MAPPINGS[page], tabId, url);
      return;
    } else {
      // Internal page
      tab.url = url;
      tab.title = page.charAt(0).toUpperCase() + page.slice(1);
      tab.favicon = "🌌";
      showInternalPage(page);
    }
    
    // Update history
    if (tab.history[tab.historyIndex] !== url) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(url);
      tab.historyIndex = tab.history.length - 1;
    }
    
    updateUrlBar(url);
    updateNavigationButtons();
    renderTabs();
    addToHistory(url, tab.title);
    return;
  }
  
  // Handle regular URLs
  url = parseUrl(url);
  proxyNavigate(url, tabId);
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

async function proxyNavigate(url, tabId = activeTabId, displayUrl = null) {
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
  const historyUrl = displayUrl || url;
  if (tab.history[tab.historyIndex] !== historyUrl) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(historyUrl);
    tab.historyIndex = tab.history.length - 1;
  }
  
  if (tabId === activeTabId) {
    tab.frame.classList.add("active");
    updateUrlBar(tab.url);
    updateNavigationButtons();
  }
  
  renderTabs();
  addToHistory(tab.url, tab.title);
  addNetworkRequest(url, "document");
}

async function configureTransport() {
  if (!connection) return;
  
  try {
    const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
    const currentTransport = await connection.getTransport();
    
    if (currentTransport !== "/epoxy/index.mjs") {
      await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
    }
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
      tab.url = newUrl;
      
      // Update UI if this is the active tab
      if (tab.id === activeTabId) {
        updateUrlBar(newUrl);
        
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
  if (url.startsWith("aurora://")) {
    const page = url.replace("aurora://", "");
    if (AURORA_PROTOCOL_MAPPINGS[page] && !AURORA_PROTOCOL_MAPPINGS[page].startsWith("aurora://")) {
      // Hide internal pages
      if (elements.homePage) elements.homePage.classList.add("hidden");
      if (elements.settingsPage) elements.settingsPage.classList.add("hidden");
      if (elements.historyPage) elements.historyPage.classList.add("hidden");
      if (elements.bookmarksPage) elements.bookmarksPage.classList.add("hidden");
      if (elements.extensionsPage) elements.extensionsPage.classList.add("hidden");
      
      if (tab.scramjetFrame) {
        tab.scramjetFrame.go(AURORA_PROTOCOL_MAPPINGS[page]);
        if (tab.frame) tab.frame.classList.add("active");
      }
      tab.url = url;
    } else {
      tab.url = url;
      showInternalPage(page);
    }
  } else {
    // Hide internal pages
    if (elements.homePage) elements.homePage.classList.add("hidden");
    if (elements.settingsPage) elements.settingsPage.classList.add("hidden");
    if (elements.historyPage) elements.historyPage.classList.add("hidden");
    if (elements.bookmarksPage) elements.bookmarksPage.classList.add("hidden");
    if (elements.extensionsPage) elements.extensionsPage.classList.add("hidden");
    
    if (tab.scramjetFrame) {
      tab.scramjetFrame.go(url);
      if (tab.frame) tab.frame.classList.add("active");
    }
    tab.url = url;
  }
  
  updateUrlBar(url);
  updateNavigationButtons();
  renderTabs();
}

function refresh() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  
  if (tab.url.startsWith("aurora://")) {
    const page = tab.url.replace("aurora://", "");
    if (AURORA_PROTOCOL_MAPPINGS[page] && !AURORA_PROTOCOL_MAPPINGS[page].startsWith("aurora://")) {
      if (tab.scramjetFrame) {
        tab.scramjetFrame.go(AURORA_PROTOCOL_MAPPINGS[page]);
      }
    } else {
      showInternalPage(page);
    }
  } else if (tab.scramjetFrame) {
    tab.scramjetFrame.go(tab.url);
  }
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
  if (elements.themeSelect) elements.themeSelect.value = settings.theme;
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
        const cookie = cookies[i];
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
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

function applyTheme() {
  // Safely remove existing theme classes without clearing other classes (like perf-mode or incognito-mode)
  const classes = Array.from(document.body.classList);
  classes.forEach(c => {
    if (c.endsWith('-theme')) document.body.classList.remove(c);
  });

  if (settings.theme && settings.theme !== "dark") {
    document.body.classList.add(`${settings.theme}-theme`);
  }
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

  try {
    if (elements.extensionInstall) {
      elements.extensionInstall.textContent = "Installing...";
      elements.extensionInstall.disabled = true;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch extension");
    const content = await response.text();

    const { metadata, code } = parseExtensionFile(content);
    
    if (extensions.some(e => e.id === metadata.id)) {
      if (!confirm(`Extension "${metadata.name}" is already installed. Update it?`)) {
        if (elements.extensionInstall) {
          elements.extensionInstall.textContent = "Install";
          elements.extensionInstall.disabled = false;
        }
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
      sourceUrl: url,
      installedAt: Date.now()
    };

    extensions.push(extension);
    saveExtensions();
    runExtension(extension);
    
    if (elements.extensionDialogOverlay) elements.extensionDialogOverlay.classList.add("hidden");
    if (elements.extensionUrlInput) elements.extensionUrlInput.value = "";
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
    alert(`Extension "${metadata.name}" installed successfully!`);

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
  } catch (e) {
    console.error(`Failed to run extension ${ext.metadata.name}:`, e);
  }
}

function renderExtensionsPage() {
  if (!elements.extensionsPage) return;

  // Inject Tabs if missing
  let tabBar = document.getElementById('ext-tabs');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'ext-tabs';
    tabBar.style.display = 'flex';
    tabBar.style.gap = '10px';
    tabBar.style.marginBottom = '20px';
    tabBar.style.flexShrink = '0';
    tabBar.innerHTML = `
      <button id="tab-installed-btn" class="settings-btn">Installed</button>
      <button id="tab-marketplace-btn" class="settings-btn">Marketplace</button>
    `;
    elements.extensionsPage.insertBefore(tabBar, elements.extensionsPage.firstChild);
    
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
      btnInstalled.style.background = currentExtensionTab === 'installed' ? 'var(--accent-color)' : 'var(--bg-secondary)';
      btnInstalled.style.color = currentExtensionTab === 'installed' ? '#fff' : 'var(--text-primary)';
  }
  if (btnMarketplace) {
      btnMarketplace.style.background = currentExtensionTab === 'marketplace' ? 'var(--accent-color)' : 'var(--bg-secondary)';
      btnMarketplace.style.color = currentExtensionTab === 'marketplace' ? '#fff' : 'var(--text-primary)';
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

  // Toggle Visibility
  elements.extensionsList.style.display = currentExtensionTab === 'installed' ? 'block' : 'none';
  elements.marketplaceList.style.display = currentExtensionTab === 'marketplace' ? 'block' : 'none';

  // Toggle Static Manual Install Controls
  // We look for the elements by ID (static ones) and hide their container if found
  const staticIds = ['extension-code-input', 'install-code-btn', 'extension-url-input', 'install-url-btn'];
  staticIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
          // Find the closest settings-section or container that isn't the page itself
          const container = el.closest('.settings-section');
          if (container && container.parentElement === elements.extensionsPage) {
              container.style.display = currentExtensionTab === 'installed' ? '' : 'none';
          }
      }
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
        <div style="flex: 1;">
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
    elements.marketplaceList.innerHTML = '<p class="devtools-info">No extensions in marketplace.</p>';
    return;
  }

  items.forEach(item => {
    const container = document.createElement("div");
    container.className = "marketplace-item";
    const installed = extensions.find(e => e.id === item.id);
    const updateAvailable = installed && compareVersions(item.version, installed.metadata.version) === 1;

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-color);">
        <div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:24px;">${item.icon||"🧩"}</div>
        <div style="flex:1;">
          <div style="font-weight:600">${escapeHtml(item.name)} <span style="font-size:12px;color:var(--text-secondary);">v${escapeHtml(item.version)}</span></div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">${escapeHtml(item.description || "")}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
          <div>
            ${installed ? `<button class="settings-btn" disabled style="margin-right:8px;">Installed</button>` : ""}
            <button class="settings-btn marketplace-install" data-url="${escapeHtml(item.fileUrl || item.url || item.file || "")}">
              ${installed ? (updateAvailable ? "Update" : "Reinstall") : "Install"}
            </button>
          </div>
          ${installed && updateAvailable ? `<div style="color:var(--accent-color);font-size:12px;">Update available</div>` : ""}
        </div>
      </div>
    `;

    const btn = container.querySelector(".marketplace-install");
    if (btn) {
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
        btn.textContent = installed ? "Updating..." : "Installing...";
        try {
          await installMarketplaceUrl(fileUrl);
          addConsoleMessage("info", `${item.name} installed/updated`);
          renderExtensionsPage(); // refresh installed list
          renderMarketplacePage(); // refresh marketplace status
        } catch (err) {
          addConsoleMessage("error", `Install failed: ${err.message || err}`);
          alert(`Install failed: ${err.message || err}`);
          btn.disabled = false;
          btn.textContent = installed ? "Update" : "Install";
        }
      });
    }

    elements.marketplaceList.appendChild(container);
  });
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

// ==================== DevTools ====================
function toggleDevTools(show = null) {
  devtoolsOpen = show !== null ? show : !devtoolsOpen;
  if (elements.devtoolsPanel) elements.devtoolsPanel.classList.toggle("hidden", !devtoolsOpen);
  
  if (devtoolsOpen) {
    // Adjust main content height
    if (elements.mainContent) elements.mainContent.style.marginBottom = "300px";
    renderDevToolsContent();
  } else {
    if (elements.mainContent) elements.mainContent.style.marginBottom = "0";
  }
}

function switchDevToolsTab(panel) {
  document.querySelectorAll(".devtools-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".devtools-pane").forEach(p => p.classList.remove("active"));
  
  const tab = document.querySelector(`.devtools-tab[data-panel="${panel}"]`);
  if (tab) tab.classList.add("active");
  const pane = document.getElementById(`devtools-${panel}`);
  if (pane) pane.classList.add("active");
  
  renderDevToolsContent();
}

function renderDevToolsContent() {
  // Elements panel
  const domTree = document.getElementById("dom-tree");
  if (!domTree) return;
  
  const tab = tabs.find(t => t.id === activeTabId);
  
  if (tab && tab.frame) {
    try {
      // Accessing contentDocument should work for same-origin (proxied) frames
      const doc = tab.frame.contentDocument || tab.frame.contentWindow.document;
      if (doc) {
        domTree.innerHTML = renderDomNode(doc.documentElement);
      } else {
        domTree.innerHTML = '<p class="devtools-info">Document not available.</p>';
      }
    } catch (e) {
      domTree.innerHTML = `<p class="devtools-info">Cannot inspect frame content: ${e.message}</p>`;
    }
  } else {
    domTree.innerHTML = '<p class="devtools-info">No page loaded.</p>';
  }
}

function renderDomNode(node, depth = 0) {
  if (!node || depth > 5) return "";
  
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.trim();
    if (text) return `<div class="dom-node">"${escapeHtml(text.substring(0, 50))}..."</div>`;
    return "";
  }
  
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  
  const tagName = node.tagName.toLowerCase();
  let attrs = "";
  
  for (const attr of node.attributes) {
    attrs += ` <span class="attr-name">${attr.name}</span>=<span class="attr-value">"${escapeHtml(attr.value.substring(0, 30))}"</span>`;
  }
  
  let html = `<div class="dom-node"><span class="tag-name">&lt;${tagName}</span>${attrs}<span class="tag-name">&gt;</span>`;
  
  if (node.children.length > 0 && depth < 3) {
    html += '<div style="padding-left: 16px;">';
    for (const child of node.children) {
      html += renderDomNode(child, depth + 1);
    }
    html += '</div>';
  } else if (node.children.length > 0) {
    html += '...';
  }
  
  html += `<span class="tag-name">&lt;/${tagName}&gt;</span></div>`;
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
  
  elements.consoleOutput.innerHTML = consoleMessages.map(msg => `
    <div class="console-message ${msg.type}">
      <span>${escapeHtml(msg.message)}</span>
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
      const win = tab.frame.contentWindow;
      
      if (type === "localStorage") {
        try {
          const storage = win.localStorage;
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            const value = storage.getItem(key);
            html += `<tr><td style="padding: 4px;">${escapeHtml(key)}</td><td style="padding: 4px;">${escapeHtml(value.substring(0, 100))}</td></tr>`;
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px;">Access denied to localStorage</td></tr>`;
        }
      } else if (type === "sessionStorage") {
        try {
          const storage = win.sessionStorage;
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            const value = storage.getItem(key);
            html += `<tr><td style="padding: 4px;">${escapeHtml(key)}</td><td style="padding: 4px;">${escapeHtml(value.substring(0, 100))}</td></tr>`;
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px;">Access denied to sessionStorage</td></tr>`;
        }
      } else if (type === "cookies") {
        try {
          const cookieStr = win.document.cookie;
          if (cookieStr) {
            const cookies = cookieStr.split(';');
            cookies.forEach(c => {
              const parts = c.trim().split('=');
              const key = parts[0];
              const value = parts.slice(1).join('=');
                           html += `<tr><td style="padding: 4px;">${escapeHtml(key)}</td><td style="padding: 4px;">${escapeHtml(value.substring(0, 100))}</td></tr>`;
            });
          } else {
             html += `<tr><td colspan="2" style="padding: 4px;">No cookies found</td></tr>`;
          }
        } catch (e) {
           html += `<tr><td colspan="2" style="padding: 4px;">Access denied to cookies</td></tr>`;
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
  
  if (elements.contextMenu) {
    elements.contextMenu.style.left = e.clientX + "px";
    elements.contextMenu.style.top = e.clientY + "px";
    elements.contextMenu.classList.remove("hidden");
  }
}

function toggleMainMenu() {
  if (elements.mainMenu) elements.mainMenu.classList.toggle("hidden");
}

function hideMenus() {
  if (elements.contextMenu) elements.contextMenu.classList.add("hidden");
  if (elements.mainMenu) elements.mainMenu.classList.add("hidden");
}

function handleContextMenuAction(action) {
  hideMenus();
  
  switch (action) {
    case "back":
      goBack();
      break;
    case "forward":
      goForward();
      break;
    case "refresh":
      refresh();
      break;
    case "view-source":
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && tab.frame) {
        toggleDevTools(true);
        switchDevToolsTab("sources");
        try {
          // Get current DOM state
          const source = tab.frame.contentDocument.documentElement.outerHTML;
          // Format slightly for readability
          const sourceCode = document.getElementById("source-code");
          if (sourceCode) sourceCode.textContent = source;
        } catch (e) {
          const sourceCode = document.getElementById("source-code");
          if (sourceCode) sourceCode.textContent = "Cannot access source: " + e.message;
        }
      }
      break;
    case "inspect":
      toggleDevTools(true);
      switchDevToolsTab("elements");
      break;
  }
}

function handleMainMenuAction(action) {
  hideMenus();
  
  switch (action) {
    case "new-tab":
      createTab("aurora://home", "New Tab");
      break;
    case "new-window":
      window.open(location.href, "_blank");
      break;
    case "history":
      navigate("aurora://history");
      break;
    case "bookmarks":
      navigate("aurora://bookmarks");
      break;
    case "extensions":
      navigate("aurora://extensions");
      break;
    case "downloads":
      addConsoleMessage("info", "Downloads feature coming soon.");
      break;
    case "zoom-in":
      document.body.style.zoom = (parseFloat(document.body.style.zoom) || 1) + 0.1;
      break;
    case "zoom-out":
      document.body.style.zoom = Math.max(0.5, (parseFloat(document.body.style.zoom) || 1) - 0.1);
      break;
    case "zoom-reset":
      document.body.style.zoom = 1;
      break;
    case "find":
      addConsoleMessage("info", "Use Ctrl+F in the browser for find functionality.");
      break;
    case "print":
      window.print();
      break;
    case "devtools":
      toggleDevTools();
      break;
    case "settings":
      navigate("aurora://settings");
      break;
    case "about":
      alert("Aurora Browser v1.0.0\n\nA sophisticated web proxy browser built on Scramjet technology.\n\nCopyright 2025 Firewall Freedom by Sirco");
      break;
  }
}

// ==================== Utilities ====================
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
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const fileName = path.split("/").pop() || urlObj.hostname;
    return fileName.length > 40 ? fileName.substring(0, 40) + "..." : fileName;
  } catch (e) {
    return url.substring(0, 40);
  }
}

// Ensure registerSW exists if not loaded from register-sw.js
if (typeof registerSW === 'undefined') {
  window.registerSW = async function() {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('/sw.js');
    }
  };
}
