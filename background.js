let lastActivatedTabId = null;
let currentActivatedTabId = null;
const globalMarks = {}; // Will be loaded from storage

// Load marks from storage when the extension starts
browser.storage.local.get("quickVimFox_globalMarks").then(data => {
    if (data.quickVimFox_globalMarks) {
        Object.assign(globalMarks, data.quickVimFox_globalMarks);
    }
});

browser.tabs.onActivated.addListener(activeInfo => {
    if (currentActivatedTabId !== null && currentActivatedTabId !== activeInfo.tabId) {
        // Only update lastActivatedTabId if currentActivatedTabId was valid and different
        browser.tabs.get(currentActivatedTabId).then(() => {
            lastActivatedTabId = currentActivatedTabId;
        }).catch(() => {
            // currentActivatedTabId was not a valid tab (e.g., closed)
            // If lastActivatedTabId was also pointing to activeInfo.tabId, clear it.
            if (lastActivatedTabId === activeInfo.tabId) {
                 lastActivatedTabId = null;
            }
        });
    }
    currentActivatedTabId = activeInfo.tabId;
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (tabId === lastActivatedTabId) {
        lastActivatedTabId = null;
    }
    if (tabId === currentActivatedTabId) {
        currentActivatedTabId = null;
    }
    // Remove mark if it was associated with this tabId and URL is not primary key
    for (const key in globalMarks) {
        if (globalMarks[key].tabId === tabId) {
            // Optionally, keep the mark but clear its tabId, or remove it
            // For simplicity, let's assume marks are primarily URL-based for restoration
            // but tabId helps quickly switch back. If tab is gone, tabId part of mark is stale.
            globalMarks[key].tabIdStale = true; // Mark tabId as potentially stale
        }
    }
});


// Listen for messages from content scripts
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tab = sender.tab; // Tab that sent the message
    const activeTabId = tab ? tab.id : currentActivatedTabId; // Fallback to current if sender.tab is not available

    switch (request.action) {
        case "closeTab":
            if (activeTabId) browser.tabs.remove(activeTabId).catch(e => console.error("[QuickVimFox] Error closing tab:", e));
            break;
        case "closePinnedTab": // For !d - For this simple version, same as 'd'
            if (activeTabId) browser.tabs.remove(activeTabId).catch(e => console.error("[QuickVimFox] Error closing pinned tab:", e));
            break;
        case "restoreTab":
            browser.sessions.getRecentlyClosed({ maxResults: 1 }).then(sessions => {
                if (sessions.length > 0) {
                    const sessionToRestore = sessions[0];
                    if (sessionToRestore.tab && sessionToRestore.tab.sessionId) {
                        browser.sessions.restore(sessionToRestore.tab.sessionId).catch(e => console.error("[QuickVimFox] Error restoring tab session:", e));
                    } else if (sessionToRestore.window && sessionToRestore.window.sessionId) {
                         browser.sessions.restore(sessionToRestore.window.sessionId).catch(e => console.error("[QuickVimFox] Error restoring window session:", e));
                    }
                }
            }).catch(e => console.error("[QuickVimFox] Error getting recently closed sessions:", e));
            break;
        case "reloadTab":
            if (activeTabId) browser.tabs.reload(activeTabId).catch(e => console.error("[QuickVimFox] Error reloading tab:", e));
            break;
        case "forceReloadTab":
            if (activeTabId) browser.tabs.reload(activeTabId, { bypassCache: true }).catch(e => console.error("[QuickVimFox] Error force reloading tab:", e));
            break;
        case "switchTabRelative": // { direction: -1 for K, 1 for J }
            browser.tabs.query({ currentWindow: true }).then(tabs => {
                if (!activeTabId && tabs.length > 0) { // If somehow activeTabId is not set, try to get current
                    const currentActive = tabs.find(t => t.active);
                    if (currentActive) activeTabId = currentActive.id;
                    else return; // No active tab to operate on
                }
                const currentTabDetails = tabs.find(t => t.id === activeTabId);
                if (!currentTabDetails) return;

                let currentIndex = currentTabDetails.index;
                let newIndex = (currentIndex + request.direction + tabs.length) % tabs.length;
                if (tabs[newIndex] && tabs[newIndex].id) {
                    browser.tabs.update(tabs[newIndex].id, { active: true }).catch(e => console.error("[QuickVimFox] Error switching tab:", e));
                }
            }).catch(e => console.error("[QuickVimFox] Error querying tabs for relative switch:", e));
            break;
        case "switchToFirstTab":
            browser.tabs.query({ currentWindow: true, index: 0 }).then(tabs => {
                if (tabs.length > 0 && tabs[0].id) browser.tabs.update(tabs[0].id, { active: true }).catch(e => console.error("[QuickVimFox] Error switching to first tab:", e));
            }).catch(e => console.error("[QuickVimFox] Error querying for first tab:", e));
            break;
        case "switchToLastTab":
            browser.tabs.query({ currentWindow: true }).then(tabs => {
                if (tabs.length > 0 && tabs[tabs.length - 1].id) browser.tabs.update(tabs[tabs.length - 1].id, { active: true }).catch(e => console.error("[QuickVimFox] Error switching to last tab:", e));
            }).catch(e => console.error("[QuickVimFox] Error querying for last tab:", e));
            break;
        case "switchToPreviousTab":
            if (lastActivatedTabId) {
                browser.tabs.get(lastActivatedTabId)
                    .then(tabToActivate => browser.tabs.update(tabToActivate.id, { active: true }))
                    .catch(() => {
                        console.warn("[QuickVimFox] Previous tab ID no longer valid or error getting tab.");
                        lastActivatedTabId = null; // Clear invalid ID
                    });
            }
            break;
        case "togglePinTab":
            if (activeTabId) {
                browser.tabs.get(activeTabId).then(currentTab => {
                    browser.tabs.update(activeTabId, { pinned: !currentTab.pinned }).catch(e => console.error("[QuickVimFox] Error toggling pin state:", e));
                }).catch(e => console.error("[QuickVimFox] Error getting tab for pinning:", e));
            }
            break;
        case "duplicateTab":
            if (activeTabId) browser.tabs.duplicate(activeTabId).catch(e => console.error("[QuickVimFox] Error duplicating tab:", e));
            break;
        case "openInNewTabAndFocus": // For P
             browser.tabs.create({ url: request.url, active: true }).catch(e => console.error("[QuickVimFox] Error creating new tab:", e));
            break;
        case "viewSource":
            if (tab && tab.url) { // Ensure we have the sender tab's URL
                if (!tab.url.startsWith("about:") && !tab.url.startsWith("moz-extension:") && !tab.url.startsWith("file:")) {
                    browser.tabs.create({ url: 'view-source:' + tab.url }).catch(e => console.error("[QuickVimFox] Error opening view source:", e));
                } else {
                    console.warn("[QuickVimFox] Cannot view source for this URL type:", tab.url);
                }
            }
            break;
        case "storeGlobalMark":
            globalMarks[request.mark.key] = {
                url: request.mark.url,
                x: request.mark.scrollX,
                y: request.mark.scrollY,
                tabId: activeTabId, // Store current tabId for quick switch if still valid
                timestamp: Date.now()
            };
            browser.storage.local.set({ quickVimFox_globalMarks: globalMarks });
            break;
        case "gotoGlobalMark":
            const mark = globalMarks[request.key];
            if (mark) {
                // Try to find if a tab with this URL is already open
                browser.tabs.query({ url: mark.url, currentWindow: true }).then(foundTabs => {
                    let targetTab = null;
                    if (mark.tabId && !mark.tabIdStale) { // If we have a non-stale tabId attempt
                        const potentialTab = foundTabs.find(t => t.id === mark.tabId);
                        if (potentialTab) targetTab = potentialTab;
                    }

                    if (!targetTab && foundTabs.length > 0) { // Fallback to first tab with matching URL
                        targetTab = foundTabs[0];
                    }

                    const performScrollOnTab = (tabIdToScroll) => {
                        browser.scripting.executeScript({
                            target: { tabId: tabIdToScroll },
                            func: (x, y) => window.scrollTo(x, y),
                            args: [mark.x, mark.y]
                        }).catch(e => console.warn("[QuickVimFox] Could not scroll on tab:", e));
                    };

                    if (targetTab) { // Found an existing tab
                        browser.tabs.update(targetTab.id, { active: true }).then(() => {
                            performScrollOnTab(targetTab.id);
                        });
                    } else { // No existing tab, create new one
                        browser.tabs.create({ url: mark.url, active: true }).then(newTab => {
                            // Wait a bit for the page to load before trying to scroll
                            // A more robust way would be to listen for tab onUpdated status complete
                            const listener = (tabIdUpdated, changeInfo, updatedTab) => {
                                if (tabIdUpdated === newTab.id && changeInfo.status === 'complete') {
                                    performScrollOnTab(newTab.id);
                                    browser.tabs.onUpdated.removeListener(listener);
                                }
                            };
                            browser.tabs.onUpdated.addListener(listener);
                            // Timeout as a fallback if onUpdated doesn't fire as expected or too late
                            setTimeout(() => {
                                performScrollOnTab(newTab.id);
                                browser.tabs.onUpdated.removeListener(listener); // Ensure cleanup
                            }, 1500);
                        });
                    }
                });
            }
            break;
    }
    return true; // For async sendResponse, though not used much here
});

// Initialize currentActivatedTabId and lastActivatedTabId on startup
browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs.length > 0) {
        currentActivatedTabId = tabs[0].id;
        // Try to find a previously active tab if possible (e.g. from session data)
        // For simplicity, we'll just start with null for lastActivatedTabId
    }
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tab = sender.tab;
    const activeTabId = tab ? tab.id : currentActivatedTabId;

    switch (request.action) {
        // ... (保留所有现有的 case: "closeTab", "restoreTab", etc.)

        case "executeCommand":
            if (request.commandName === "buffer") {
                handleBufferCommand(request.commandArgs, sendResponse);
                return true; // Indicates sendResponse will be called asynchronously
            }
            // Potentially other commands here in the future
            break;

        case "switchToTabId": // New action to switch tab by ID
            if (request.tabId) {
                browser.tabs.update(request.tabId, { active: true })
                    .then(() => sendResponse({ status: "success" }))
                    .catch(e => {
                        console.error("[QuickVimFox] Error switching to tab ID:", request.tabId, e);
                        sendResponse({ status: "error", message: e.message });
                    });
                return true; // Indicates sendResponse will be called asynchronously
            }
            break;
    }
    // For synchronous handlers or if not returning true from an async path
    // sendResponse({}); // Or some default response if needed by sender immediately.
    return false; // Or true if any path above returned true and this is a fallback.
                  // It's safer to be explicit. If a case handles sendResponse, it should return true.
});

async function handleBufferCommand(argsString, sendResponse) {
    const query = argsString ? argsString.toLowerCase().trim() : "";
    try {
        const tabs = await browser.tabs.query({ currentWindow: true });
        let matchingTabs = [];

        if (!query) { // No query, list all tabs
            matchingTabs = tabs;
        } else {
            matchingTabs = tabs.filter(t =>
                (t.title && t.title.toLowerCase().includes(query)) ||
                (t.url && t.url.toLowerCase().includes(query))
            );
        }

        if (matchingTabs.length === 0) {
            sendResponse({ command: "buffer", status: "no_match", query: argsString });
        } else if (matchingTabs.length === 1) {
            await browser.tabs.update(matchingTabs[0].id, { active: true });
            sendResponse({ command: "buffer", status: "switched_directly", tabId: matchingTabs[0].id, title: matchingTabs[0].title });
        } else {
            const results = matchingTabs.map((t, index) => ({
                id: t.id,
                title: t.title || "Untitled Tab",
                url: t.url,
                displayIndex: index + 1 // 1-based for user display
            }));
            sendResponse({ command: "buffer", status: "multiple_matches", results: results, query: argsString });
        }
    } catch (e) {
        console.error("[QuickVimFox] Error in handleBufferCommand:", e);
        sendResponse({ command: "buffer", status: "error", message: e.message });
    }
}

console.log("QuickVimFox background script loaded.");
