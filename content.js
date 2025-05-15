(function() {
    if (window.quickVimFoxLoaded) {
        return;
    }
    window.quickVimFoxLoaded = true;

    let isEnabled = true;
    let currentMode = "normal"; // "normal", "follow", "mark_set", "mark_goto", "search_input"
    let keyBuffer = "";
    let followModeNewTab = false;
    let activeHints = [];
    let localMarks = {}; // For current tab session marks (m<char>)
    let searchBar = null;
    let lastSearchQuery = "";
    let lastSearchDirectionForward = true;
    let temporarilyDisableKeys = false; // True when a text input field is focused

    let commandLineContainer = null;
    let commandLineInput = null;
    let commandLineDisplay = null;
    let displayedBufferList = []; // To store results from :buffer command
    const HINT_CHARS = "asdfghjklqwertyuiopzxcvbnm"; // Characters for hints

    // Load enabled state from storage
    browser.storage.local.get("quickVimFox_isEnabled").then(result => {
        if (result.quickVimFox_isEnabled !== undefined) {
            isEnabled = result.quickVimFox_isEnabled;
        }
    });

    // --- Helper Functions ---
    function getScrollableElement() {
        if (document.body.scrollHeight > window.innerHeight || document.body.scrollWidth > window.innerWidth) {
            return window; // scroll window
        }
        // Fallback or more specific scrollable element detection can be added here if needed
        return window;
    }

    function getScrollAmount() {
        return 75; // Standard scroll amount
    }

    function getPageScrollAmount() {
        return window.innerHeight * 0.9; // Almost a full page
    }
    function getHalfPageScrollAmount() {
        return window.innerHeight / 2;
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            // console.log("[QuickVimFox] URL copied to clipboard:", text);
        }).catch(err => {
            console.error("[QuickVimFox] Failed to copy URL:", err);
        });
    }

    function focusFirstInput() {
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]');
        for (let input of inputs) {
            // Check if element is visible
            const style = window.getComputedStyle(input);
            if (style.display !== 'none' && style.visibility !== 'hidden' && input.offsetHeight > 0 && input.offsetWidth > 0) {
                input.focus();
                if (input.select) input.select(); // Select text if it's a text input
                return true;
            }
        }
        return false;
    }

    function navigateRel(type) { // 'prev' or 'next'
        const rel = type === 'prev' ? 'prev' : 'next';
        const link = document.querySelector(`link[rel="${rel}" i], a[rel="${rel}" i]`);
        if (link && link.href) {
            window.location.href = link.href;
            return true;
        }
        // Basic fallback for common text patterns (can be expanded)
        const commonTextsPrev = ['previous', 'prev', '<', '‹', '«'];
        const commonTextsNext = ['next', '>', '›', '»'];
        const textsToSearch = type === 'prev' ? commonTextsPrev : commonTextsNext;
        const links = Array.from(document.querySelectorAll('a[href]'));

        for (const text of textsToSearch) {
            const found = links.find(a => a.textContent.trim().toLowerCase() === text.toLowerCase() || a.getAttribute('aria-label')?.toLowerCase().includes(text.toLowerCase()));
            if (found) {
                window.location.href = found.href;
                return true;
            }
        }
        console.warn(`[QuickVimFox] No "${rel}" link found.`);
        return false;
    }

    function navigateUpDirectory() {
        try {
            const url = new URL(window.location.href);
            if (url.protocol === "about:" || url.protocol === "moz-extension:") return;

            if (url.protocol === "file:") {
                let path = url.pathname.replace(/\\/g, '/');
                if (path.endsWith('/')) path = path.slice(0, -1);
                const lastSlash = path.lastIndexOf('/');
                if (lastSlash > 0) { // e.g. /C:/foo/bar -> /C:/foo/  or /C:/foo -> /C:/
                    url.pathname = path.substring(0, lastSlash + 1);
                    window.location.href = url.href;
                } else if (lastSlash === 0 && path.length > 1) { // e.g. /foo -> /
                     url.pathname = '/';
                     window.location.href = url.href;
                } // else at root like /C:/ or /, do nothing
                return;
            }

            if (url.pathname === "/" || url.pathname === "") return;
            const pathSegments = url.pathname.split('/').filter(Boolean);
            if (pathSegments.length > 0) {
                pathSegments.pop();
                url.pathname = '/' + pathSegments.join('/') + (pathSegments.length > 0 ? '/' : '');
                url.search = ''; url.hash = ''; // Clear params and hash when going up
                window.location.href = url.href;
            }
        } catch (e) { console.error("[QuickVimFox] Error navigating up:", e); }
    }

    function navigateToRoot() {
        try {
            const url = new URL(window.location.href);
            if (url.protocol === "about:" || url.protocol === "moz-extension:") return;

            if (url.protocol === "file:") {
                let path = url.pathname.replace(/\\/g, '/');
                const firstRealDirSlash = path.indexOf('/', path.startsWith('//') ? 2 : (path.startsWith('/') ? 1 : 0));
                if (firstRealDirSlash > 0 ) { // e.g. /C:/foo/bar -> /C:/
                     const driveOrBasePath = path.substring(0, firstRealDirSlash +1);
                     if (driveOrBasePath !== path) { // ensure not already at root
                        url.pathname = driveOrBasePath;
                        window.location.href = url.href;
                     }
                } // else already at root
                return;
            }
            url.pathname = '/';
            url.search = '';
            url.hash = '';
            window.location.href = url.href;
        } catch (e) { console.error("[QuickVimFox] Error navigating to root:", e); }
    }

    // --- Follow Mode ---
    function createHintElement(targetElement, hintText, newTab) {
        const rect = targetElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
            return null; // Element is not visible or outside viewport
        }

        const hint = document.createElement('div');
        hint.textContent = hintText;
        hint.className = 'quickvimfox-hint';
        hint.style.top = `${window.scrollY + rect.top}px`;
        hint.style.left = `${window.scrollX + rect.left}px`;
        hint.style.backgroundColor = newTab ? '#004882' : '#ffa500'; // Different color for new tab
        hint.dataset.targetHref = targetElement.href;
        hint.dataset.targetElement = targetElement; // Keep reference for click
        document.body.appendChild(hint);
        return hint;
    }

    function generateHintString(index) {
        let base = HINT_CHARS.length;
        let hintStr = "";
        let num = index;
        do {
            hintStr = HINT_CHARS[num % base] + hintStr;
            num = Math.floor(num / base) -1; // -1 because 'a' is 0, 'aa' comes after 'z'
        } while (num >=0);
         return hintStr;
    }


    function startFollowMode(newTab) {
        if (currentMode !== "normal") return;
        removeHints(); // Clear any previous hints

        const clickableElements = Array.from(document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"], input[type="reset"], [role="link"], [role="button"], [onclick]'))
            .filter(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                       rect.top >= 0 && rect.left >= 0 &&
                       rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                       rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                       style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            });

        if (clickableElements.length === 0) return;

        currentMode = "follow";
        followModeNewTab = newTab;
        keyBuffer = ""; // Buffer for hint characters

        clickableElements.forEach((el, i) => {
            const hintStr = generateHintString(i);
            const hintElement = createHintElement(el, hintStr, newTab);
            if (hintElement) {
                activeHints.push({ element: el, hintText: hintStr, hintDOM: hintElement });
            }
        });
    }

    function removeHints() {
        activeHints.forEach(h => h.hintDOM.remove());
        activeHints = [];
        currentMode = "normal";
        keyBuffer = "";
    }

    function processFollowKey(key) {
        keyBuffer += key.toLowerCase();
        let RETAIN_FOCUS = false; // Some elements might need to retain focus after click, e.g. inputs.
        let matchedHint = null;

        // Filter hints based on current keyBuffer
        const potentialMatches = [];
        activeHints.forEach(h => {
            if (h.hintText.startsWith(keyBuffer)) {
                potentialMatches.push(h);
                h.hintDOM.classList.add('quickvimfox-hint-typed'); // Highlight potential matches
                if (h.hintText === keyBuffer) {
                    matchedHint = h;
                }
            } else {
                h.hintDOM.style.display = 'none'; // Hide non-matching hints
            }
        });
        
        if (potentialMatches.length === 0) { // No match, or bad key
            removeHints();
            return;
        }
        
        if (potentialMatches.length === 1 && potentialMatches[0].hintText === keyBuffer) {
             matchedHint = potentialMatches[0];
        }


        if (matchedHint) {
            const targetElement = matchedHint.element;
            const href = targetElement.href;

            if (followModeNewTab) {
                if (href) {
                    browser.runtime.sendMessage({ action: "openInNewTabAndFocus", url: href });
                } else if (targetElement.click) { // For buttons or elements with onclick
                    // Clicking in a new tab context is hard. We can try to duplicate tab and click, or just open link if possible.
                    // For simplicity, if it's not a link, new tab follow might not work as expected for non-anchor elements.
                    // We can send a message to background to open a new tab with the URL, if it is a link.
                    // If it is a button, clicking it should happen in the current tab.
                    // Let's adjust: if it's a button, F should perhaps act like 'f' or do nothing.
                    // For this version: F only works reliably for actual links.
                    console.warn("[QuickVimFox] 'F' mode on non-link element might not open in new tab as expected. Clicking in current.");
                    targetElement.click();
                }
            } else {
                // For current tab, simulate a click
                // For links, ensure modifier keys aren't pressed which might alter behavior
                if (targetElement.click) {
                     targetElement.focus(); // Focus before click
                     targetElement.click();
                } else if (href) {
                    window.location.href = href;
                }
            }
            removeHints();
        } else if (activeHints.every(h => h.hintDOM.style.display === 'none')) {
            // All hints are hidden, meaning no valid sequence can be formed
            removeHints();
        }
    }

    // --- Marks ---
    function setMark(key) {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const url = window.location.href;

        if (key >= 'a' && key <= 'z') { // Local mark
            localMarks[key] = { x: scrollX, y: scrollY, url: url }; // Store URL for context
        } else if (key >= 'A' && key <= 'Z') { // Global mark
            browser.runtime.sendMessage({
                action: "storeGlobalMark",
                mark: { key: key, scrollX: scrollX, scrollY: scrollY, url: url }
            });
        }
        currentMode = "normal";
    }

    function gotoMark(key) {
        if (key >= 'a' && key <= 'z') { // Local mark
            const mark = localMarks[key];
            // Only jump if on the same URL for local marks, for simplicity
            if (mark && mark.url === window.location.href) {
                window.scrollTo(mark.x, mark.y);
            } else if (mark) {
                // If URL different, could offer to go to mark.url, but spec implies current tab only
                console.warn("[QuickVimFox] Local mark '"+key+"' was for a different URL or not set in this session.");
            }
        } else if (key >= 'A' && key <= 'Z') { // Global mark
            browser.runtime.sendMessage({ action: "gotoGlobalMark", key: key });
        }
        currentMode = "normal";
    }

    // --- Search ---
    function createSearchBar() {
        if (searchBar) return;
        searchBar = document.createElement('div');
        searchBar.className = 'quickvimfox-search-bar';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.id = 'quickvimfox-search-input';
        searchInput.placeholder = 'Search...';
        const searchStatus = document.createElement('span');
        searchStatus.id = 'quickvimfox-search-status';

        searchBar.appendChild(document.createTextNode('/ '));
        searchBar.appendChild(searchInput);
        searchBar.appendChild(searchStatus);
        document.body.appendChild(searchBar);

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                lastSearchQuery = searchInput.value;
                if (lastSearchQuery) {
                    findNextWithStatus(true, false); // Search forward, not from selection
                }
                // Keep search bar open to allow n/N
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideSearchBar();
            }
        });
        searchInput.focus();
    }

      function createCommandLine() {
        if (commandLineContainer) return;

        commandLineContainer = document.createElement('div');
        commandLineContainer.className = 'quickvimfox-command-line-container';
        commandLineContainer.style.display = 'none'; // Initially hidden

        const bar = document.createElement('div');
        bar.className = 'quickvimfox-command-line-bar';

        const colonPrefix = document.createElement('span');
        colonPrefix.className = 'quickvimfox-colon-prefix';
        colonPrefix.textContent = ':';
        bar.appendChild(colonPrefix);

        commandLineInput = document.createElement('input');
        commandLineInput.type = 'text';
        commandLineInput.className = 'quickvimfox-command-line-input';
        commandLineInput.addEventListener('keydown', handleCommandLineInputKeydown);
        bar.appendChild(commandLineInput);
        commandLineContainer.appendChild(bar);

        commandLineDisplay = document.createElement('div');
        commandLineDisplay.className = 'quickvimfox-command-display';
        commandLineContainer.appendChild(commandLineDisplay); // Display area below input

        document.body.appendChild(commandLineContainer);
    }

    function showCommandLine(prefill = "") {
        if (!commandLineContainer) createCommandLine();
        if (searchBar) hideSearchBar(); // Hide search bar if active

        commandLineContainer.style.display = 'flex';
        commandLineInput.value = prefill;
        commandLineInput.focus();
        currentMode = "command_line";
        commandLineDisplay.innerHTML = ""; // Clear previous display
    }

    function hideCommandLine() {
        if (commandLineContainer) {
            commandLineContainer.style.display = 'none';
            commandLineInput.value = "";
            commandLineDisplay.innerHTML = "";
        }
        if (document.activeElement === commandLineInput) {
            commandLineInput.blur();
        }
        currentMode = "normal";
        displayedBufferList = [];
    }

    function showInCommandDisplay(htmlContent, autoHideDelay = 0) {
        if (!commandLineDisplay) createCommandLine(); // Should exist if command line is up
        commandLineDisplay.innerHTML = htmlContent;
        if (autoHideDelay > 0) {
            setTimeout(() => {
                // Only hide if the message is still the one we set
                if (commandLineDisplay.innerHTML === htmlContent) {
                    commandLineDisplay.innerHTML = "";
                    if(currentMode !== "buffer_selection" && currentMode !== "command_line"){ // if not expecting further input
                         hideCommandLine();
                    } else if (currentMode === "command_line" && !commandLineInput.value) {
                        // if command line is empty and no results are actively shown for selection
                        commandLineInput.focus(); // refocus, maybe user wants to type another command
                    }
                }
            }, autoHideDelay);
        }
    }

    function processTypedCommand(fullCmdText) {
        let text = fullCmdText.trim();
        if (text.startsWith(':')) {
            text = text.substring(1);
        }
        if (!text) { // Empty command
            hideCommandLine();
            return;
        }

        const parts = text.split(/\s+/);
        let commandName = parts[0].toLowerCase();
        const commandArgs = parts.slice(1).join(' ');

        // Alias handling
        if (commandName === 'b' || commandName === 'buf') commandName = 'buffer';

        if (commandName === 'buffer') {
            showInCommandDisplay("<i>Searching tabs...</i>");
            browser.runtime.sendMessage({ action: "executeCommand", commandName: "buffer", commandArgs: commandArgs })
                .then(handleBufferCommandResponse)
                .catch(err => {
                    console.error("[QuickVimFox] Error sending buffer command:", err);
                    showInCommandDisplay(`Error: ${err.message}`, 3000);
                    commandLineInput.focus(); // Allow re-editing
                });
        } else {
            showInCommandDisplay(`Error: Unknown command: ${commandName}`, 3000);
            commandLineInput.value = fullCmdText; // Keep text for editing
            commandLineInput.focus();
        }
    }

    function handleBufferCommandResponse(response) {
        if (!response || !response.command === "buffer") return;

        if (response.status === "switched_directly") {
            showInCommandDisplay(`Switched to: ${response.title ? response.title.substring(0, 80) : 'Tab ID ' + response.tabId}`, 1500);
            // Hide command line after a short delay, if no error.
            setTimeout(hideCommandLine, 1500);
        } else if (response.status === "no_match") {
            showInCommandDisplay(`No tabs found matching "<i>${response.query || ''}</i>".`, 0); // Don't auto-hide
            commandLineInput.value = `:${response.query ? 'buffer ' + response.query : 'buffer '}`; // Restore for editing
            commandLineInput.focus();
        } else if (response.status === "multiple_matches") {
            displayedBufferList = response.results;
            let listHTML = `Matching tabs for "<i>${response.query || ''}</i>":<br/><ul>`;
            displayedBufferList.forEach((tab) => {
                let tabUrl = tab.url || "";
                if (tabUrl.length > 70) tabUrl = tabUrl.substring(0, 67) + "...";
                listHTML += `<li><span class="quickvimfox-buffer-idx">[${tab.displayIndex}]</span> ${tab.title} <small>(${tabUrl})</small></li>`;
            });
            listHTML += "</ul>Type number and Enter to switch, or Esc to cancel.";
            showInCommandDisplay(listHTML, 0); // Don't auto-hide
            currentMode = "buffer_selection"; // Switch mode to handle number input
            commandLineInput.value = ""; // Clear input for number selection
            commandLineInput.focus();
        } else if (response.status === "error") {
            showInCommandDisplay(`Error: ${response.message}`, 3000);
            commandLineInput.focus();
        }
    }

    function handleCommandLineInputKeydown(e) {
        // This listener is specifically for the commandLineInput element
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            const commandText = commandLineInput.value;

            if (currentMode === "command_line") {
                processTypedCommand(commandText);
            } else if (currentMode === "buffer_selection") {
                const selectionNumber = parseInt(commandText.trim(), 10);
                if (!isNaN(selectionNumber) && selectionNumber > 0 && selectionNumber <= displayedBufferList.length) {
                    const selectedTab = displayedBufferList.find(t => t.displayIndex === selectionNumber);
                    if (selectedTab) {
                        showInCommandDisplay(`<i>Switching to [${selectionNumber}] ${selectedTab.title}...</i>`);
                        browser.runtime.sendMessage({ action: "switchToTabId", tabId: selectedTab.id })
                            .then(resp => {
                                if (resp && resp.status === "success") {
                                    hideCommandLine();
                                } else {
                                    showInCommandDisplay(`Error switching: ${resp ? resp.message : 'Unknown error'}`, 3000);
                                }
                            })
                            .catch(err => {
                                showInCommandDisplay(`Error switching: ${err.message}`, 3000);
                            });
                    }
                } else {
                    showInCommandDisplay("Invalid selection. Type number and Enter, or Esc.", 0);
                    commandLineInput.value = ""; // Clear invalid input
                    commandLineInput.focus();
                }
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideCommandLine(); // Global escape handler might also catch this, but good to be specific
        }
        // For other keys, default input behavior is desired. No e.stopPropagation() unless it's Enter/Esc.
    }

    function hideSearchBar() {
        if (searchBar) {
            searchBar.remove();
            searchBar = null;
        }
        currentMode = "normal";
        if (document.activeElement && document.activeElement.id === 'quickvimfox-search-input') {
            document.activeElement.blur();
        }
         // Clear selection from find
        if (window.getSelection) {
            const selection = window.getSelection();
            if (selection.removeAllRanges && !selection.isCollapsed) {
                 // Check if selection is from find. Not easy.
                 // For now, let's not clear selection if user might want it.
            }
        }
    }
    
    function findNextWithStatus(forward, fromSelection = true) {
        const inputField = document.getElementById('quickvimfox-search-input');
        const statusField = document.getElementById('quickvimfox-search-status');
        if (inputField) lastSearchQuery = inputField.value; // Update query if bar is open

        if (!lastSearchQuery) {
            if (statusField) statusField.textContent = "No query";
            return;
        }
        
        // window.find is case-insensitive by default in Firefox if aCaseSensitive is false
        // It also wraps around the document.
        // `aBackwards`, `aWrapAround`, `aCaseSensitive`, `aSearchInFrames`, `aShowDialog`
        try {
            const found = window.find(lastSearchQuery, false, !forward, true, false, fromSelection, false);
            if (statusField) {
                statusField.textContent = found ? "" : "[Not found]";
            }
        } catch (e) {
            // window.find can sometimes throw if used on about:blank or similar
            console.warn("[QuickVimFox] window.find error:", e);
            if (statusField) statusField.textContent = "[Error]";
        }
    }


    function startSearchMode() {
        if (currentMode !== "normal") return;
        currentMode = "search_input";
        createSearchBar();
        const inputField = document.getElementById('quickvimfox-search-input');
        if (inputField) {
            inputField.value = lastSearchQuery; // Pre-fill with last search
            inputField.select();
            inputField.focus();
        }
    }


    // --- Event Listener ---
    document.addEventListener('focusin', (event) => {
        if (!isEnabled) return;
        const target = event.target;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
            if (target.id !== 'quickvimfox-search-input') { // Don't disable for our own search input
                // console.log("[QuickVimFox] Entering temporary insert mode.");
                temporarilyDisableKeys = true;
            }
        }
    });

    document.addEventListener('focusout', (event) => {
        if (!isEnabled) return;
        const target = event.target;
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
             // console.log("[QuickVimFox] Exiting temporary insert mode.");
            temporarilyDisableKeys = false;
        }
    });


    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (currentMode === 'follow') {
                removeHints();
                e.preventDefault(); e.stopPropagation(); return;
            } else if (currentMode === 'search_input') {
                hideSearchBar();
                e.preventDefault(); e.stopPropagation(); return;
            } else if (currentMode === 'mark_set' || currentMode === 'mark_goto') {
                currentMode = "normal";
                e.preventDefault(); e.stopPropagation(); return;
            } else if (temporarilyDisableKeys) {
                if (document.activeElement) document.activeElement.blur(); // Try to blur input
                temporarilyDisableKeys = false; // Re-enable shortcuts
                e.preventDefault(); e.stopPropagation(); return;
            }
            keyBuffer = ""; // Clear any pending multi-key command
        }

        if (e.shiftKey && e.key === 'Escape') {
            isEnabled = !isEnabled;
            browser.storage.local.set({ quickVimFox_isEnabled: isEnabled });
            console.log(`[QuickVimFox] Extension ${isEnabled ? "Enabled" : "Disabled"}`);
            if (!isEnabled) { // If disabling, clean up modes
                if (currentMode === 'follow') removeHints();
                if (currentMode === 'search_input') hideSearchBar();
                currentMode = 'normal';
            }
            e.preventDefault(); e.stopPropagation();
            return;
        }

        if (!isEnabled || (temporarilyDisableKeys && e.key !== 'Escape')) {
            return;
        }
        
        // Mode-specific handling
        if (currentMode === 'follow') {
            if (HINT_CHARS.includes(e.key.toLowerCase()) || (e.key >= '0' && e.key <= '9')) { // Allow numbers if hintchars includes them
                processFollowKey(e.key);
            } else if (e.key === 'Backspace') { // Allow backspace to correct hint
                 keyBuffer = keyBuffer.slice(0, -1);
                 // Re-filter/show hints based on new shorter keyBuffer
                 activeHints.forEach(h => {
                    if (h.hintText.startsWith(keyBuffer)) {
                        h.hintDOM.style.display = ''; // Show again
                        h.hintDOM.classList.remove('quickvimfox-hint-typed'); // Reset typed style
                        if(keyBuffer.length > 0 && h.hintText.substring(0, keyBuffer.length) === keyBuffer) {
                             h.hintDOM.classList.add('quickvimfox-hint-typed');
                        }
                    } else {
                        // It was already hidden, or should be if no longer matches
                    }
                 });
            }
            e.preventDefault(); e.stopPropagation(); return;
        } else if (currentMode === 'mark_set') {
            if ((e.key >= 'a' && e.key <= 'z') || (e.key >= 'A' && e.key <= 'Z')) {
                setMark(e.key);
                e.preventDefault(); e.stopPropagation(); return;
            } else { currentMode = 'normal'; /* Invalid key, reset */ }
        } else if (currentMode === 'mark_goto') {
            if ((e.key >= 'a' && e.key <= 'z') || (e.key >= 'A' && e.key <= 'Z')) {
                gotoMark(e.key);
                e.preventDefault(); e.stopPropagation(); return;
            } else { currentMode = 'normal'; /* Invalid key, reset */ }
        } else if (currentMode === 'search_input') {
            // Handled by searchInput's own keydown listener mostly
            // Escape is handled globally above
            if (e.key !== "Escape" && e.key !== "Enter") { // Prevent page from reacting to other keys
                 e.stopPropagation(); // Don't preventDefault, allow typing in input
            }
            return; // Let search input handle it
        }


        // Normal mode, multi-key sequences first
        let prevKeyBuffer = keyBuffer;
        if (keyBuffer !== "") {
            keyBuffer += e.key;
            let commandProcessed = true;
            switch (keyBuffer) {
                case 'gg': window.scrollTo(0, 0); break;
                case 'g0': browser.runtime.sendMessage({ action: "switchToFirstTab" }); break;
                case 'g$': browser.runtime.sendMessage({ action: "switchToLastTab" }); break;
                case 'gu': navigateUpDirectory(); break;
                case 'gU': navigateToRoot(); break;
                case 'gi': focusFirstInput(); break;
                case 'gf': browser.runtime.sendMessage({ action: "viewSource" }); break;
                case 'zp': browser.runtime.sendMessage({ action: "togglePinTab" }); break;
                case 'zd': browser.runtime.sendMessage({ action: "duplicateTab" }); break;
                case '[[': navigateRel('prev'); break;
                case ']]': navigateRel('next'); break;
                case '!d': browser.runtime.sendMessage({ action: "closePinnedTab" }); break;
                default:
                    commandProcessed = false; // Not a full command yet or invalid
                    break;
            }
            if (commandProcessed) {
                keyBuffer = "";
                e.preventDefault(); e.stopPropagation(); return;
            } else if (keyBuffer.length >= 2 && !['g', 'z', '[', ']', '!'].some(p => keyBuffer.startsWith(p) && p.length < keyBuffer.length)) {
                // Invalid sequence or too long for current prefixes
                keyBuffer = ""; // Reset buffer
            } else if (prevKeyBuffer === keyBuffer) { // Key didn't change buffer (e.g. modifier key pressed)
                // Do nothing, wait for next valid char
            } else {
                 // It's a valid prefix (e.g. "g"), wait for next key
                 e.preventDefault(); e.stopPropagation(); return;
            }
        }

        // Single key commands (if keyBuffer is empty or was reset)
        if (keyBuffer === "") {
            let commandProcessed = true;
            const scrollEl = getScrollableElement();

            if (e.ctrlKey) {
                switch (e.key) {
                    case 'u': scrollEl.scrollBy(0, -getHalfPageScrollAmount()); break;
                    case 'd': scrollEl.scrollBy(0, getHalfPageScrollAmount()); break;
                    case 'b': scrollEl.scrollBy(0, -getPageScrollAmount()); break;
                    case 'f': scrollEl.scrollBy(0, getPageScrollAmount()); break;
                    case '6': browser.runtime.sendMessage({ action: "switchToPreviousTab" }); break;
                    default: commandProcessed = false;
                }
            } else if (e.shiftKey) { // Shift + Key (excluding Escape, handled above)
                switch (e.key) {
                    case 'G': window.scrollTo(0, document.body.scrollHeight); break;
                    case 'R': browser.runtime.sendMessage({ action: "forceReloadTab" }); break;
                    case 'K': browser.runtime.sendMessage({ action: "switchTabRelative", direction: -1 }); break;
                    case 'J': browser.runtime.sendMessage({ action: "switchTabRelative", direction: 1 }); break;
                    case 'H': window.history.back(); break;
                    case 'L': window.history.forward(); break;
                    case 'P':
                        navigator.clipboard.readText().then(text => {
                            if (text) {
                                try {
                                    new URL(text); // Basic validation
                                    browser.runtime.sendMessage({ action: "openInNewTabAndFocus", url: text });
                                } catch (err) { console.warn("[QuickVimFox] Clipboard content for 'P' not a valid URL:", text); }
                            }
                        }).catch(err => console.error("[QuickVimFox] Could not read clipboard for 'P':", err));
                        break;
                    case 'F': startFollowMode(true); break;
                    case 'N': if (lastSearchQuery) findNextWithStatus(false); else startSearchMode(); break;
                    // `!d` is Shift+1 then d, handled by keyBuffer.
                    default: commandProcessed = false;
                }
            } else { // No Ctrl, No Shift
                switch (e.key) {
                    // Scroll
                    case 'k': scrollEl.scrollBy(0, -getScrollAmount()); break;
                    case 'j': scrollEl.scrollBy(0, getScrollAmount()); break;
                    case 'h': scrollEl.scrollBy(0, -getScrollAmount()); break; // Horizontal scroll
                    case 'l': scrollEl.scrollBy(getScrollAmount(), 0); break; // Horizontal scroll
                    case '0': window.scrollTo(0, window.pageYOffset); break;
                    case '$': window.scrollTo(document.body.scrollWidth, window.pageYOffset); break;
                    // Tabs & Other
                    case 'd': browser.runtime.sendMessage({ action: "closeTab" }); break;
                    case 'u': browser.runtime.sendMessage({ action: "restoreTab" }); break;
                    case 'r': browser.runtime.sendMessage({ action: "reloadTab" }); break;
                    case 'y': copyToClipboard(window.location.href); break;
                    case 'p':
                        navigator.clipboard.readText().then(text => {
                            if (text) {
                                try {
                                    new URL(text); // Basic validation
                                    window.location.href = text;
                                } catch (err) { console.warn("[QuickVimFox] Clipboard content for 'p' not a valid URL:", text); }
                            }
                        }).catch(err => console.error("[QuickVimFox] Could not read clipboard for 'p':", err));
                        break;
                    case 'f': startFollowMode(false); break;
                    case '/': startSearchMode(); break;
                    case 'n': if (lastSearchQuery) findNextWithStatus(true); else startSearchMode(); break;
                    // Sequence starters
                    case 'g': case 'z': case '[': case ']': case '!': // ! for !d
                        keyBuffer = e.key; commandProcessed = true; /* Will wait for next key */ break;
                    case 'm': currentMode = "mark_set"; commandProcessed = true; break;
                    case "'": currentMode = "mark_goto"; commandProcessed = true; break;
                    default: commandProcessed = false;
                }
            }

            if (commandProcessed) {
                e.preventDefault(); e.stopPropagation();
            }
        }
    });
    console.log("QuickVimFox content script loaded.");
})();
