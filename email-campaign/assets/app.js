(() => {
  const labelTableCells = (root = document) => {
    root.querySelectorAll("table").forEach((table) => {
      const headers = Array.from(table.querySelectorAll("thead th")).map((header) =>
        header.textContent.replace(/\s+/g, " ").trim()
      );
      if (!headers.length) return;
      table.querySelectorAll("tbody tr").forEach((row) => {
        Array.from(row.children).forEach((cell, index) => {
          if (cell.tagName !== "TD" || cell.colSpan > 1 || cell.dataset.label) return;
          cell.dataset.label = headers[index] || "";
        });
      });
    });
  };
  labelTableCells();
  window.labelTableCells = labelTableCells;
})();

document.querySelectorAll(".campaign-detail-form").forEach((form) => {
  const editor = form.querySelector(".editor");
  const html = form.querySelector(".body-html");
  const source = form.querySelector(".html-source");
  const toolbar = form.querySelector(".toolbar");
  const imageInput = form.querySelector(".editor-image-input");
  const imageResizeHandle = document.createElement("span");
  let mode = "preview";
  let savedRange = null;
  let selectedImage = null;
  imageResizeHandle.className = "editor-image-resizer is-hidden";
  imageResizeHandle.setAttribute("aria-hidden", "true");
  document.body.appendChild(imageResizeHandle);
  const syncHidden = () => {
    if (!html) return;
    html.value = mode === "html" && source ? source.value : editor ? editor.innerHTML : html.value;
  };
  const rememberSelection = () => {
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange();
    }
  };
  const restoreSelection = () => {
    if (!editor || !savedRange) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(savedRange);
    return true;
  };
  const normalizeLinkUrl = (url) => {
    const value = String(url || "").trim();
    if (value === "" || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#")) return value;
    return `https://${value}`;
  };
  const escapeHtml = (text) =>
    text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  const imageTag = (src) => `<img src="${src}" class="email-inline-image" alt="">`;
  const normalizeEditorImages = () => {
    if (!editor) return;
    editor.querySelectorAll("img").forEach((image) => {
      image.classList.add("email-inline-image");
      image.draggable = false;
      image.removeAttribute("srcset");
      if (image.style.height && image.style.width) image.style.height = "";
      if (image.hasAttribute("height") && image.hasAttribute("width")) image.removeAttribute("height");
    });
  };
  const clearImageSelection = () => {
    if (selectedImage) selectedImage.classList.remove("is-selected");
    selectedImage = null;
    imageResizeHandle.classList.add("is-hidden");
  };
  const placeImageResizeHandle = () => {
    if (!selectedImage || !editor || !document.body.contains(selectedImage) || mode !== "preview") {
      clearImageSelection();
      return;
    }
    const rect = selectedImage.getBoundingClientRect();
    imageResizeHandle.style.left = `${rect.right}px`;
    imageResizeHandle.style.top = `${rect.bottom}px`;
    imageResizeHandle.classList.toggle("is-hidden", rect.width < 1 || rect.height < 1);
  };
  const selectImage = (image) => {
    if (!image || !editor || !editor.contains(image)) return;
    normalizeEditorImages();
    if (selectedImage && selectedImage !== image) selectedImage.classList.remove("is-selected");
    selectedImage = image;
    selectedImage.classList.add("is-selected");
    placeImageResizeHandle();
  };
  const linkSelectedImage = (url) => {
    if (!selectedImage || !editor || !editor.contains(selectedImage)) return false;
    const existingLink = selectedImage.closest("a");
    if (existingLink && editor.contains(existingLink)) {
      if (url === "") {
        existingLink.replaceWith(selectedImage);
      } else {
        existingLink.href = url;
        existingLink.target = "_blank";
        existingLink.rel = "noopener";
      }
      selectImage(selectedImage);
      syncHidden();
      return true;
    }
    if (url === "") return true;
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    selectedImage.parentNode.insertBefore(link, selectedImage);
    link.appendChild(selectedImage);
    selectImage(selectedImage);
    syncHidden();
    return true;
  };
  const insertImageFiles = async (files) => {
    const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const dataUrls = await Promise.all(imageFiles.map(readFileAsDataUrl));
    insertHtmlAtCursor(dataUrls.map(imageTag).join(""));
    normalizeEditorImages();
    const inserted = editor ? Array.from(editor.querySelectorAll("img.email-inline-image")).pop() : null;
    if (inserted) selectImage(inserted);
  };
  const insertHtmlAtCursor = (markup) => {
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    restoreSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const fragment = range.createContextualFragment(markup);
      const lastNode = fragment.lastChild;
      range.insertNode(fragment);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        savedRange = range.cloneRange();
      }
      normalizeEditorImages();
      syncHidden();
      return;
    }
    if (document.queryCommandSupported && document.queryCommandSupported("insertHTML")) {
      document.execCommand("insertHTML", false, markup);
      normalizeEditorImages();
      rememberSelection();
      syncHidden();
      return;
    }
    if (!selection || selection.rangeCount === 0) {
      editor.insertAdjacentHTML("beforeend", markup);
      normalizeEditorImages();
      syncHidden();
      return;
    }
  };
  const normalizePastedHtmlImages = (markup, dataUrls) => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = markup;
    const images = Array.from(wrapper.querySelectorAll("img"));
    let used = 0;
    images.forEach((image) => {
      const src = image.getAttribute("src") || "";
      const brokenEmbeddedReference =
        src === "" || src.startsWith("cid:") || src.startsWith("file:") || src.startsWith("blob:") || src.startsWith("data:application/");
      if (brokenEmbeddedReference && dataUrls[used]) {
        image.setAttribute("src", dataUrls[used]);
        image.classList.add("email-inline-image");
        used += 1;
      } else if (src.startsWith("data:image/") && dataUrls[used]) {
        used += 1;
      }
      image.removeAttribute("srcset");
    });
    dataUrls.slice(used).forEach((src) => {
      wrapper.insertAdjacentHTML("beforeend", imageTag(src));
    });
    return wrapper.innerHTML;
  };
  const clipboardImageFiles = (clipboard) => {
    const files = [];
    const add = (file) => {
      if (!file || !file.type.startsWith("image/")) return;
      const key = [file.name, file.size, file.type, file.lastModified].join(":");
      if (files.some((entry) => entry.key === key)) return;
      files.push({ key, file });
    };
    Array.from(clipboard.items || []).forEach((item) => {
      if (item.kind === "file" && item.type.startsWith("image/")) add(item.getAsFile());
    });
    Array.from(clipboard.files || []).forEach(add);
    return files.map((entry) => entry.file);
  };
  const handlePaste = async (event) => {
    if (!editor || mode !== "preview") return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    rememberSelection();
    const imageFiles = clipboardImageFiles(clipboard);
    const pastedHtml = clipboard.getData("text/html");
    if (!imageFiles.length && !pastedHtml) {
      window.setTimeout(syncHidden, 0);
      return;
    }
    event.preventDefault();
    const dataUrls = await Promise.all(imageFiles.map(readFileAsDataUrl));
    const fallbackText = clipboard.getData("text/plain");
    if (!pastedHtml && !fallbackText) {
      insertHtmlAtCursor(dataUrls.map(imageTag).join(""));
      return;
    }
    const markup = pastedHtml || escapeHtml(fallbackText).replace(/\n/g, "<br>");
    insertHtmlAtCursor(normalizePastedHtmlImages(markup, dataUrls));
  };
  const setMode = (nextMode) => {
    if (nextMode === mode) return;
    if (nextMode === "html") clearImageSelection();
    if (nextMode === "html" && source && editor) source.value = editor.innerHTML;
    if (nextMode === "preview" && source && editor) {
      editor.innerHTML = source.value;
      normalizeEditorImages();
    }
    mode = nextMode;
    form.querySelectorAll("[data-editor-mode]").forEach((button) => {
      const active = button.dataset.editorMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (editor) editor.classList.toggle("is-hidden", mode !== "preview");
    if (source) source.classList.toggle("is-hidden", mode !== "html");
    if (toolbar) toolbar.classList.toggle("is-hidden", mode !== "preview");
    if (mode !== "preview") clearImageSelection();
    syncHidden();
  };
  form.querySelectorAll("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.editorMode));
  });
  form.querySelectorAll("[data-cmd]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!editor) return;
      editor.focus();
      document.execCommand(button.dataset.cmd, false, null);
      syncHidden();
    });
  });
  form.querySelectorAll("[data-link]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!editor) return;
      const existingImageLink = selectedImage?.closest("a");
      const currentUrl = existingImageLink && editor.contains(existingImageLink) ? existingImageLink.getAttribute("href") || "" : "";
      const url = prompt(selectedImage ? "URL odkazu pro obrazek" : "URL odkazu", currentUrl);
      if (url === null) return;
      const normalizedUrl = normalizeLinkUrl(url);
      if (selectedImage && linkSelectedImage(normalizedUrl)) return;
      editor.focus();
      restoreSelection();
      if (normalizedUrl) {
        document.execCommand("createLink", false, normalizedUrl);
      } else {
        document.execCommand("unlink", false, null);
      }
      syncHidden();
    });
  });
  form.querySelectorAll("[data-image-upload]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberSelection();
      imageInput?.click();
    });
  });
  imageInput?.addEventListener("change", () => {
    insertImageFiles(imageInput.files);
    imageInput.value = "";
  });
  if (editor) {
    normalizeEditorImages();
    editor.addEventListener("focus", rememberSelection);
    editor.addEventListener("keyup", rememberSelection);
    editor.addEventListener("mouseup", (event) => {
      rememberSelection();
      const image = event.target.closest ? event.target.closest("img") : null;
      if (image && editor.contains(image)) selectImage(image);
    });
    editor.addEventListener("click", (event) => {
      const image = event.target.closest ? event.target.closest("img") : null;
      if (image && editor.contains(image)) {
        event.preventDefault();
        selectImage(image);
      } else if (!event.target.closest(".editor-image-resizer")) {
        clearImageSelection();
      }
    });
    editor.addEventListener("input", () => {
      normalizeEditorImages();
      rememberSelection();
      placeImageResizeHandle();
      syncHidden();
    });
  }
  if (editor) editor.addEventListener("paste", handlePaste);
  if (source) source.addEventListener("input", syncHidden);
  imageResizeHandle.addEventListener("pointerdown", (event) => {
    if (!selectedImage || !editor) return;
    event.preventDefault();
    selectedImage.setAttribute("contenteditable", "false");
    imageResizeHandle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = selectedImage.getBoundingClientRect().width;
    const editorWidth = Math.max(120, editor.getBoundingClientRect().width - 32);
    const onMove = (moveEvent) => {
      const width = Math.max(32, Math.min(editorWidth, startWidth + moveEvent.clientX - startX));
      selectedImage.style.width = `${Math.round(width)}px`;
      selectedImage.style.height = "";
      selectedImage.removeAttribute("width");
      selectedImage.removeAttribute("height");
      placeImageResizeHandle();
      syncHidden();
    };
    const onUp = () => {
      selectedImage?.removeAttribute("contenteditable");
      imageResizeHandle.removeEventListener("pointermove", onMove);
      imageResizeHandle.removeEventListener("pointerup", onUp);
      imageResizeHandle.removeEventListener("pointercancel", onUp);
      syncHidden();
    };
    imageResizeHandle.addEventListener("pointermove", onMove);
    imageResizeHandle.addEventListener("pointerup", onUp);
    imageResizeHandle.addEventListener("pointercancel", onUp);
  });
  window.addEventListener("scroll", placeImageResizeHandle, true);
  window.addEventListener("resize", placeImageResizeHandle);
  form.addEventListener("submit", () => {
    clearImageSelection();
    syncHidden();
  });
});

document.querySelectorAll(".toggle-detail").forEach((button) => {
  button.addEventListener("click", () => {
    const row = document.getElementById(button.dataset.target);
    if (!row) return;
    const hidden = row.classList.toggle("hidden");
    button.textContent = hidden ? "Zobrazit" : "Sbalit";
    button.setAttribute("aria-expanded", hidden ? "false" : "true");
  });
});

function toggleDetailRow(trigger) {
  const detail = document.getElementById(trigger.dataset.detailTarget || "");
  if (!detail) return;
  const hidden = detail.classList.toggle("hidden");
  trigger.setAttribute("aria-expanded", hidden ? "false" : "true");
  trigger.classList.toggle("is-open", !hidden);
}

document.addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-dialog-open]");
  if (openButton) {
    const dialog = document.getElementById(openButton.dataset.dialogOpen);
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "open");
    }
    return;
  }

  const closeButton = event.target.closest("[data-dialog-close]");
  if (closeButton) {
    const dialog = closeButton.closest("dialog");
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    return;
  }

  const groupHeader = event.target.closest(".scraping-result-group > h3");
  if (groupHeader) {
    const group = groupHeader.closest(".scraping-result-group");
    if (!group) return;
    const collapsed = group.classList.toggle("is-collapsed");
    groupHeader.setAttribute("aria-expanded", collapsed ? "false" : "true");
    return;
  }

  const row = event.target.closest(".expandable-row");
  if (row && !event.target.closest("a, button, input, select, textarea, label, form")) {
    toggleDetailRow(row);
    return;
  }

  const linkRow = event.target.closest(".link-row[data-href]");
  if (!linkRow || event.target.closest("a, button, input, select, textarea, label, form")) return;
  window.location.href = linkRow.dataset.href;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const groupHeader = event.target.closest(".scraping-result-group > h3");
  if (groupHeader) {
    event.preventDefault();
    groupHeader.click();
    return;
  }
  const row = event.target.closest(".expandable-row");
  if (row && !event.target.closest("a, button, input, select, textarea")) {
    event.preventDefault();
    toggleDetailRow(row);
    return;
  }

  const linkRow = event.target.closest(".link-row[data-href]");
  if (!linkRow || event.target.closest("a, button, input, select, textarea")) return;
  event.preventDefault();
  window.location.href = linkRow.dataset.href;
});

function userIsEditing() {
  const active = document.activeElement;
  return Boolean(
    document.querySelector("dialog[open]") ||
      active?.closest("form") ||
      active?.matches("input, select, textarea, [contenteditable='true']")
  );
}

function expandedState(root = document) {
  return {
    rows: new Set(
      Array.from(root.querySelectorAll(".expandable-row.is-open"))
        .map((row) => row.dataset.detailTarget)
        .filter(Boolean)
    ),
    groups: new Set(
      Array.from(root.querySelectorAll(".scraping-result-group:not(.is-collapsed) > h3"))
        .map((header) => header.closest(".detail-row")?.id + "::" + header.textContent.trim())
        .filter(Boolean)
    ),
  };
}

function restoreExpandedState(state) {
  document.querySelectorAll(".expandable-row").forEach((row) => {
    const open = state.rows.has(row.dataset.detailTarget);
    row.classList.toggle("is-open", open);
    row.setAttribute("aria-expanded", open ? "true" : "false");
    const detail = document.getElementById(row.dataset.detailTarget || "");
    if (detail) detail.classList.toggle("hidden", !open);
  });
  document.querySelectorAll(".scraping-result-group > h3").forEach((header) => {
    const key = header.closest(".detail-row")?.id + "::" + header.textContent.trim();
    const open = state.groups.has(key);
    const group = header.closest(".scraping-result-group");
    if (!group) return;
    group.classList.toggle("is-collapsed", !open);
    header.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

async function refreshScrapingTables() {
  if (!document.body.classList.contains("view-scraping") || userIsEditing()) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("async", Date.now().toString());
    const response = await fetch(url.toString(), { headers: { "X-Requested-With": "fetch" }, cache: "no-store" });
    if (!response.ok) return;
    const html = await response.text();
    const fresh = new DOMParser().parseFromString(html, "text/html");
    const state = expandedState();
    [".container-table tbody", ".log-table tbody"].forEach((selector) => {
      const current = document.querySelector(selector);
      const next = fresh.querySelector(selector);
      if (current && next) current.innerHTML = next.innerHTML;
    });
    window.labelTableCells?.();
    restoreExpandedState(state);
  } catch (_error) {
    // Keep the current UI stable; the next polling cycle can try again.
  }
}

if (document.body.classList.contains("view-scraping") && document.querySelector(".badge.live")) {
  window.setInterval(refreshScrapingTables, 12000);
}

async function refreshContactImportHistory() {
  if (!document.body.classList.contains("view-contacts") || userIsEditing()) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("async", Date.now().toString());
    const response = await fetch(url.toString(), { headers: { "X-Requested-With": "fetch" }, cache: "no-store" });
    if (!response.ok) return;
    const html = await response.text();
    const fresh = new DOMParser().parseFromString(html, "text/html");
    const current = document.querySelector(".import-history tbody");
    const next = fresh.querySelector(".import-history tbody");
    if (current && next) {
      current.innerHTML = next.innerHTML;
      window.labelTableCells?.(current.closest("table") || document);
    }
  } catch (_error) {
    // The next poll can retry.
  }
}

if (document.body.classList.contains("view-contacts") && document.querySelector(".import-history .badge.live")) {
  window.setInterval(refreshContactImportHistory, 12000);
}

const collator = new Intl.Collator("cs", { numeric: true, sensitivity: "base" });

function sortableValue(row, index) {
  const cell = row.children[index];
  if (!cell) return "";
  const text = cell.innerText.replace(/\s+/g, " ").trim();
  const number = Number(text.replace(",", "."));
  if (text !== "" && Number.isFinite(number) && /^-?\d+(?:[,.]\d+)?$/.test(text)) {
    return number;
  }
  const time = Date.parse(text);
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(time)) {
    return time;
  }
  return text.toLowerCase();
}

function rowGroups(tbody) {
  const rows = Array.from(tbody.children);
  const groups = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.classList.contains("detail-row")) continue;
    const group = [row];
    const next = rows[index + 1];
    if (next && next.classList.contains("detail-row")) {
      group.push(next);
      index += 1;
    }
    groups.push(group);
  }
  return groups;
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

function refreshVisibleRowNumbers(table) {
  const firstHeader = table.querySelector("thead th");
  if (!firstHeader || firstHeader.innerText.trim() !== "#") return;
  Array.from(table.tBodies[0]?.rows || [])
    .filter((row) => !row.classList.contains("detail-row"))
    .forEach((row, index) => {
      if (row.cells[0]) row.cells[0].textContent = String(index + 1);
    });
}

document.querySelectorAll("table").forEach((table) => {
  if (table.classList.contains("no-client-sort")) return;
  const tbody = table.tBodies[0];
  const headers = Array.from(table.tHead?.rows[0]?.cells || []);
  if (!tbody || headers.length === 0) return;

  headers.forEach((header, column) => {
    const label = header.innerText.trim().toLowerCase();
    if (["akce", "detail", "prejmenovat"].includes(label)) return;
    header.classList.add("sortable");
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const sort = () => {
      const direction = header.dataset.sort === "asc" ? "desc" : "asc";
      headers.forEach((item) => {
        item.dataset.sort = "";
        item.removeAttribute("aria-sort");
      });
      header.dataset.sort = direction;
      header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");

      rowGroups(tbody)
        .sort((left, right) => {
          const result = compareValues(sortableValue(left[0], column), sortableValue(right[0], column));
          return direction === "asc" ? result : -result;
        })
        .forEach((group) => group.forEach((row) => tbody.appendChild(row)));

      refreshVisibleRowNumbers(table);
    };

    header.addEventListener("click", sort);
    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        sort();
      }
    });
  });
});

const contactSearchInput = document.querySelector("[data-contact-search]");
const contactResults = document.querySelector("[data-contacts-results]");
let contactSearchTimer = null;
let contactSearchRequest = 0;

function setupSyncedTableScrollbars(root = document) {
  root.querySelectorAll("[data-contacts-results]").forEach((container) => {
    const top = container.querySelector("[data-table-scroll-top]");
    const main = container.querySelector("[data-table-scroll-main]");
    const spacer = top?.firstElementChild;
    const table = main?.querySelector("table");
    if (!top || !main || !spacer || !table) return;
    spacer.style.width = `${table.scrollWidth}px`;
    let syncing = false;
    const sync = (source, target) => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = source.scrollLeft;
      window.requestAnimationFrame(() => {
        syncing = false;
      });
    };
    top.addEventListener("scroll", () => sync(top, main), { passive: true });
    main.addEventListener("scroll", () => sync(main, top), { passive: true });
  });
}

setupSyncedTableScrollbars();

async function refreshContactsFromUrl(url, pushState = true) {
  if (!contactResults) return;
  const requestId = ++contactSearchRequest;
  const requestedQuery = url.searchParams.get("q") || "";
  try {
    const response = await fetch(url.toString(), { headers: { "X-Requested-With": "fetch" }, cache: "no-store" });
    if (requestId !== contactSearchRequest) return;
    if (!response.ok) return;
    const html = await response.text();
    if (requestId !== contactSearchRequest) return;
    if (contactSearchInput && contactSearchInput.value !== requestedQuery) return;
    const fresh = new DOMParser().parseFromString(html, "text/html");
    const next = fresh.querySelector("[data-contacts-results]");
    if (!next) return;
    contactResults.innerHTML = next.innerHTML;
    window.labelTableCells?.(contactResults);
    setupSyncedTableScrollbars(contactResults);
    if (pushState) window.history.replaceState({}, "", url.toString());
    const searchForm = contactSearchInput?.closest("form");
    if (searchForm) {
      ["sort", "dir", "page", "metric"].forEach((key) => {
        const field = searchForm.querySelector(`[name="${key}"]`);
        if (field) field.value = url.searchParams.get(key) || "";
      });
    }
  } catch (_error) {
    // Searching should not interrupt editing; the full form submit remains available.
  }
}

if (contactSearchInput && contactResults) {
  contactSearchInput.addEventListener("input", () => {
    window.clearTimeout(contactSearchTimer);
    contactSearchTimer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("q", contactSearchInput.value);
      url.searchParams.set("page", "1");
      refreshContactsFromUrl(url);
    }, 250);
  });

  contactResults.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link || !link.closest(".contacts-table-wrap") || link.target === "_blank") return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
    event.preventDefault();
    refreshContactsFromUrl(url);
  });
}
