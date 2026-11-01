/* Toolshed — Task Board (UI + persistence)
 *
 * All data-model logic lives in tool.js (window.Toolshed.taskBoard) and is
 * unit-tested under Node. This file only wires that model to the DOM and to
 * localStorage. It never uses innerHTML, eval or any network call: every piece
 * of user text reaches the page through textContent or input.value, so a task
 * title is always inert data, never markup.
 */
(function () {
  "use strict";

  var core = window.Toolshed && window.Toolshed.taskBoard;
  if (!core) {
    document.body.insertAdjacentText("afterbegin", "Task Board failed to load its core module.");
    return;
  }

  var STORAGE_KEY = "toolshed:task-board:v1";
  var SAVE_DEBOUNCE_MS = 250;
  var RENDER_LIMIT = 300; // keep the DOM small enough to stay snappy on huge lists

  var state = {
    tasks: [],
    query: { text: "", status: "all", priority: "", tag: "" },
    sort: "manual",
    editingId: null,
    storageOk: true
  };

  var el = {};
  var saveTimer = null;
  var statusTimer = null;
  var pendingFocus = null;
  var storageWarned = false;

  var STATUS_LABELS = {
    all: "All",
    active: "Active",
    done: "Done",
    overdue: "Overdue",
    today: "Due today",
    upcoming: "Upcoming"
  };

  var PRIORITY_LABELS = { high: "High", normal: "Normal", low: "Low" };

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  function loadFromStorage() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      state.storageOk = false;
      storageWarned = true;
      setStatus("This browser blocks local storage, so tasks will not be saved. Export to keep them.", "error", true);
      return;
    }
    if (!raw) return;

    var result = core.deserialize(raw, Date.now());
    if (result.ok) {
      state.tasks = result.tasks;
      if (result.warnings.length) { storageWarned = true; setStatus(result.warnings.join(" "), "ok"); }
    } else {
      // Never discard silently: keep the damaged payload so the user can rescue it.
      storageWarned = true;
      setStatus("Saved tasks could not be read (" + result.error + ") Starting with an empty board; the old data is left untouched in storage until you save.", "error", true);
    }
  }

  function persist() {
    if (!state.storageOk) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, core.serialize(state.tasks, Date.now()));
      flashSaved();
    } catch (err) {
      state.storageOk = false;
      storageWarned = true;
      setStatus("Could not save — this browser's storage is full or blocked. Export your tasks to avoid losing them.", "error", true);
    }
  }

  function schedulePersist() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = null;
      persist();
    }, SAVE_DEBOUNCE_MS);
  }

  function flashSaved() {
    if (!el.saveflag) return;
    el.saveflag.textContent = "Saved";
    el.saveflag.classList.add("on");
    window.setTimeout(function () {
      el.saveflag.classList.remove("on");
      el.saveflag.textContent = "";
    }, 1200);
  }

  // ---------------------------------------------------------------------
  // Status messages
  // ---------------------------------------------------------------------

  /**
   * Show a status message. `sticky` keeps a warning on screen instead of
   * auto-hiding it, so a "your data is not being saved" notice cannot be
   * missed because the user looked away.
   */
  function setStatus(message, kind, sticky) {
    if (!el.status) return;
    el.status.textContent = message;
    el.status.classList.remove("hidden", "ok", "error");
    if (kind) el.status.classList.add(kind);
    if (statusTimer) { window.clearTimeout(statusTimer); statusTimer = null; }
    if (sticky) return;
    statusTimer = window.setTimeout(function () {
      el.status.classList.add("hidden");
    }, 6000);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function visibleTasks() {
    var filtered = core.filterTasks(state.tasks, state.query, Date.now());
    return core.sortTasks(filtered, state.sort, Date.now());
  }

  function announce(message) {
    if (el.listCount) el.listCount.textContent = message;
  }

  function render() {
    renderStats();
    renderTagOptions();
    renderList();
  }

  function renderStats() {
    var s = core.taskStats(state.tasks, Date.now());
    var now = Date.now();
    var items = [
      ["Total", String(s.total), ""],
      ["Active", String(s.active), ""],
      ["Completed", String(s.done), ""],
      ["Overdue", String(s.overdue), s.overdue > 0 ? "warn" : ""],
      ["Due today", String(s.dueToday), s.dueToday > 0 ? "warn" : ""]
    ];
    el.stats.textContent = "";
    items.forEach(function (pair) {
      var dt = document.createElement("dt");
      dt.textContent = pair[0];
      var dd = document.createElement("dd");
      dd.textContent = pair[1];
      if (pair[2]) dd.className = pair[2];
      el.stats.appendChild(dt);
      el.stats.appendChild(dd);
    });

    var pct = Math.round(s.completionRate * 100);
    el.progressValue.textContent = pct + "%";
    el.progressBar.style.width = pct + "%";
    el.progressBar.parentNode.setAttribute("aria-valuenow", String(pct));
    void now;
  }

  function renderTagOptions() {
    var tags = core.allTags(state.tasks);
    var current = state.query.tag;
    el.tagFilter.textContent = "";
    var any = document.createElement("option");
    any.value = "";
    any.textContent = "Any";
    el.tagFilter.appendChild(any);
    tags.forEach(function (tag) {
      var opt = document.createElement("option");
      opt.value = tag;
      opt.textContent = "#" + tag;
      el.tagFilter.appendChild(opt);
    });
    // Restore the active tag if it still exists.
    el.tagFilter.value = tags.indexOf(current) === -1 ? "" : current;
    if (el.tagFilter.value === "" && current) state.query.tag = "";
  }

  function renderStatusChips() {
    var counts = { all: state.tasks.length, active: 0, done: 0, overdue: 0, today: 0, upcoming: 0 };
    var now = Date.now();
    state.tasks.forEach(function (t) {
      if (t.done) { counts.done += 1; return; }
      counts.active += 1;
      var s = core.dueStatus(t, now);
      if (s === "overdue") counts.overdue += 1;
      else if (s === "today") counts.today += 1;
      else if (s === "soon" || s === "later") counts.upcoming += 1;
    });

    el.statusChips.textContent = "";
    core.STATUS_FILTERS.forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.setAttribute("aria-pressed", state.query.status === key ? "true" : "false");
      var label = document.createElement("span");
      label.textContent = STATUS_LABELS[key];
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = String(counts[key]);
      btn.appendChild(label);
      btn.appendChild(n);
      btn.addEventListener("click", function () {
        state.query.status = key;
        renderStatusChips();
        renderList();
      });
      el.statusChips.appendChild(btn);
    });
  }

  function renderList() {
    var list = visibleTasks();
    var total = state.tasks.length;
    el.taskList.textContent = "";

    if (total === 0) {
      showEmpty("No tasks yet. Add one above, or load the sample board to see how it works.");
      announce("0 tasks");
      return;
    }
    if (list.length === 0) {
      showEmpty("Nothing matches these filters. Adjust the search or clear the filters.");
      announce("0 of " + total + " tasks shown");
      return;
    }

    hideEmpty();
    var shown = list.slice(0, RENDER_LIMIT);
    shown.forEach(function (task) {
      el.taskList.appendChild(renderTask(task));
    });

    if (list.length > shown.length) {
      var note = document.createElement("li");
      note.className = "render-note";
      note.textContent = "Showing the first " + shown.length + " of " + list.length +
        " matching tasks. Narrow the filters to see the rest.";
      el.taskList.appendChild(note);
    }

    announce(list.length + (list.length === 1 ? " task" : " tasks") +
      (list.length === total ? "" : " of " + total) + " shown");
    restoreFocus();
  }

  function showEmpty(message) {
    el.emptyState.classList.remove("hidden");
    el.emptyMessage.textContent = message;
  }

  function hideEmpty() {
    el.emptyState.classList.add("hidden");
  }

  function renderTask(task) {
    var li = document.createElement("li");
    li.className = "task";
    li.dataset.id = task.id;
    if (task.done) li.classList.add("done");
    var dueState = core.dueStatus(task, Date.now());
    if (!task.done && dueState !== "none") li.classList.add("due-" + dueState);

    if (state.editingId === task.id) {
      li.appendChild(renderEditor(task));
      return li;
    }

    // --- checkbox ---
    var checkWrap = document.createElement("label");
    checkWrap.className = "check";
    var check = document.createElement("input");
    check.type = "checkbox";
    check.checked = task.done;
    check.dataset.action = "toggle";
    check.setAttribute("aria-label", (task.done ? "Mark active: " : "Mark done: ") + task.title);
    var box = document.createElement("span");
    box.className = "box";
    box.setAttribute("aria-hidden", "true");
    checkWrap.appendChild(check);
    checkWrap.appendChild(box);

    // --- body ---
    var body = document.createElement("div");
    body.className = "body";

    var title = document.createElement("span");
    title.className = "title";
    title.textContent = task.title; // inert text, never markup
    body.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "meta";

    if (task.priority !== "normal") {
      var p = document.createElement("span");
      p.className = "badge pri-" + task.priority;
      p.textContent = PRIORITY_LABELS[task.priority];
      meta.appendChild(p);
    }
    if (task.due) {
      var d = document.createElement("span");
      d.className = "badge due";
      var label = core.dueLabel(task, Date.now());
      d.textContent = label + " · " + task.due;
      meta.appendChild(d);
    }
    task.tags.forEach(function (tag) {
      var t = document.createElement("span");
      t.className = "badge tag";
      t.textContent = "#" + tag;
      meta.appendChild(t);
    });
    if (task.notes) {
      var n = document.createElement("span");
      n.className = "badge note";
      n.textContent = task.notes.length > 60 ? task.notes.slice(0, 60) + "…" : task.notes;
      n.title = task.notes;
      meta.appendChild(n);
    }
    if (meta.childNodes.length) body.appendChild(meta);

    // --- actions ---
    var actions = document.createElement("div");
    actions.className = "task-actions";

    var edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.dataset.action = "edit";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit: " + task.title);

    var del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn danger";
    del.dataset.action = "delete";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete: " + task.title);

    var up = document.createElement("button");
    up.type = "button";
    up.className = "icon-btn";
    up.dataset.action = "up";
    up.textContent = "↑";
    up.setAttribute("aria-label", "Move up: " + task.title);

    var down = document.createElement("button");
    down.type = "button";
    down.className = "icon-btn";
    down.dataset.action = "down";
    down.textContent = "↓";
    down.setAttribute("aria-label", "Move down: " + task.title);

    actions.appendChild(edit);
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(del);

    li.appendChild(checkWrap);
    li.appendChild(body);
    li.appendChild(actions);

    li.draggable = state.sort === "manual";
    if (li.draggable) li.setAttribute("title", "Drag to reorder");
    return li;
  }

  function renderEditor(task) {
    var form = document.createElement("form");
    form.className = "editor";
    form.dataset.action = "save";

    function field(labelText, control) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = labelText;
      var id = "edit-" + task.id + "-" + labelText.replace(/\s+/g, "-").toLowerCase();
      control.id = id;
      label.setAttribute("for", id);
      wrap.appendChild(label);
      wrap.appendChild(control);
      return wrap;
    }

    var title = document.createElement("input");
    title.type = "text";
    title.maxLength = core.MAX_TITLE;
    title.value = task.title;
    title.required = true;
    title.dataset.role = "title";

    var due = document.createElement("input");
    due.type = "date";
    due.value = task.due || "";

    var priority = document.createElement("select");
    core.PRIORITIES.slice().reverse().forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      opt.textContent = PRIORITY_LABELS[p];
      if (task.priority === p) opt.selected = true;
      priority.appendChild(opt);
    });

    var tags = document.createElement("input");
    tags.type = "text";
    tags.value = task.tags.join(", ");
    tags.placeholder = "work, home";

    var notes = document.createElement("textarea");
    notes.rows = 3;
    notes.maxLength = core.MAX_NOTES;
    notes.value = task.notes || "";
    notes.placeholder = "Notes (optional)";

    var grid = document.createElement("div");
    grid.className = "editor-grid";
    grid.appendChild(field("Due date", due));
    grid.appendChild(field("Priority", priority));
    grid.appendChild(field("Tags", tags));

    var actions = document.createElement("div");
    actions.className = "actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "btn";
    save.textContent = "Save";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn secondary";
    cancel.dataset.action = "cancel";
    cancel.textContent = "Cancel";
    actions.appendChild(save);
    actions.appendChild(cancel);

    form.appendChild(field("Title", title));
    form.appendChild(grid);
    form.appendChild(field("Notes", notes));
    form.appendChild(actions);

    form._fields = { title: title, due: due, priority: priority, tags: tags, notes: notes };
    window.setTimeout(function () { title.focus(); title.select(); }, 0);
    return form;
  }

  function restoreFocus() {
    if (!pendingFocus) return;
    var id = pendingFocus.id;
    var action = pendingFocus.action;
    pendingFocus = null;
    var li = el.taskList.querySelector('[data-id="' + cssEscape(id) + '"]');
    if (!li) return;
    var target = li.querySelector('[data-action="' + action + '"]') || li;
    if (target && typeof target.focus === "function") target.focus();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function rememberFocus(id, action) {
    pendingFocus = { id: id, action: action };
  }

  // ---------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------

  function commit(nextTasks, focus) {
    state.tasks = nextTasks;
    if (focus) pendingFocus = focus;
    schedulePersist();
    renderStatusChips();
    render();
  }

  function addFromForm(event) {
    event.preventDefault();
    var input = {
      title: el.titleInput.value,
      due: el.dueInput.value,
      priority: el.priorityInput.value,
      tags: el.tagsInput.value
    };
    var check = core.validateTaskInput(input);
    if (!check.ok) {
      setStatus(check.errors.join(" "), "error");
      el.titleInput.focus();
      return;
    }
    var order = state.tasks.reduce(function (max, t) { return Math.max(max, t.order || 0); }, 0) + 1;
    var task;
    try {
      task = core.createTask(input, { order: order });
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }
    commit(core.addTask(state.tasks, task));
    el.composer.reset();
    el.priorityInput.value = "normal";
    el.titleInput.focus();
    setStatus("Added “" + task.title + "”.", "ok");
  }

  function handleListClick(event) {
    var btn = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!btn) return;
    var li = event.target.closest(".task");
    if (!li) return;
    var id = li.dataset.id;
    var action = btn.dataset.action;

    if (action === "edit") {
      state.editingId = id;
      renderList();
    } else if (action === "cancel") {
      state.editingId = null;
      renderList();
    } else if (action === "delete") {
      var task = state.tasks[core.findIndex(state.tasks, id)];
      commit(core.removeTask(state.tasks, id));
      setStatus(task ? "Deleted “" + task.title + "”." : "Task deleted.", "ok");
    } else if (action === "up") {
      move(id, -1);
    } else if (action === "down") {
      move(id, 1);
    }
  }

  /** Move a task one position among the currently visible tasks. */
  function move(id, delta) {
    var shown = visibleTasks();
    var at = -1;
    for (var i = 0; i < shown.length; i++) {
      if (shown[i].id === id) { at = i; break; }
    }
    if (at === -1) return;
    var neighbour = shown[at + delta];
    if (!neighbour) return;
    var targetIndex = core.findIndex(state.tasks, neighbour.id);
    if (targetIndex === -1) return;
    var fromIndex = core.findIndex(state.tasks, id);
    if (fromIndex === -1) return;
    commit(core.moveTask(state.tasks, id, targetIndex), { id: id, action: delta > 0 ? "down" : "up" });
  }

  function handleListChange(event) {
    var target = event.target;
    if (target && target.dataset && target.dataset.action === "toggle") {
      var li = target.closest(".task");
      if (!li) return;
      commit(core.toggleDone(state.tasks, li.dataset.id), { id: li.dataset.id, action: "toggle" });
    }
  }

  function handleEditorSubmit(event) {
    var form = event.target.closest ? event.target.closest('form[data-action="save"]') : null;
    if (!form) return;
    event.preventDefault();
    var li = form.closest(".task");
    if (!li) return;
    var id = li.dataset.id;
    var f = form._fields;
    var patch = {
      title: f.title.value,
      due: f.due.value || null,
      priority: f.priority.value,
      tags: f.tags.value,
      notes: f.notes.value
    };
    try {
      var next = core.updateTask(state.tasks, id, patch, Date.now());
      state.editingId = null;
      commit(next, { id: id, action: "edit" });
      setStatus("Task updated.", "ok");
    } catch (err) {
      setStatus((err.validation || [err.message]).join(" "), "error");
      f.title.focus();
    }
  }

  function handleListKeydown(event) {
    var li = event.target.closest ? event.target.closest(".task") : null;
    if (!li) return;
    if (event.key === "Escape" && state.editingId) {
      state.editingId = null;
      renderList();
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(li.dataset.id, event.key === "ArrowUp" ? -1 : 1);
    }
  }

  // ---------------------------------------------------------------------
  // Drag and drop (manual order)
  // ---------------------------------------------------------------------

  var dragId = null;

  function handleDragStart(event) {
    var li = event.target.closest ? event.target.closest(".task") : null;
    if (!li || state.sort !== "manual") {
      event.preventDefault();
      return;
    }
    dragId = li.dataset.id;
    li.classList.add("dragging");
    try {
      event.dataTransfer.setData("text/plain", dragId);
      event.dataTransfer.effectAllowed = "move";
    } catch (err) { /* some browsers restrict setData; the id is already captured */ }
  }

  function handleDragOver(event) {
    if (!dragId) return;
    var li = event.target.closest ? event.target.closest(".task") : null;
    if (!li || li.dataset.id === dragId) return;
    event.preventDefault();
    clearDropMarkers();
    li.classList.add("drop-target");
  }

  function handleDrop(event) {
    var li = event.target.closest ? event.target.closest(".task") : null;
    clearDropMarkers();
    if (!dragId || !li) { dragId = null; return; }
    event.preventDefault();
    var targetId = li.dataset.id;
    var dragged = dragId;
    dragId = null;
    if (targetId === dragged) return;
    var to = core.findIndex(state.tasks, targetId);
    if (to === -1) return;
    commit(core.moveTask(state.tasks, dragged, to), { id: dragged, action: "edit" });
  }

  function handleDragEnd() {
    dragId = null;
    clearDropMarkers();
  }

  function clearDropMarkers() {
    var marked = el.taskList.querySelectorAll(".drop-target, .dragging");
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove("drop-target", "dragging");
    }
  }

  // ---------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------

  function syncQueryFromControls() {
    state.query.text = el.search.value;
    state.query.priority = el.priorityFilter.value;
    state.query.tag = el.tagFilter.value;
    state.sort = el.sort.value;
  }

  function clearFilters() {
    el.search.value = "";
    el.priorityFilter.value = "";
    el.tagFilter.value = "";
    el.sort.value = "manual";
    state.query = { text: "", status: "all", priority: "", tag: "" };
    state.sort = "manual";
    renderStatusChips();
    renderList();
  }

  // ---------------------------------------------------------------------
  // Bulk actions
  // ---------------------------------------------------------------------

  function markAll(done) {
    if (!state.tasks.length) {
      setStatus("There are no tasks to update.", "error");
      return;
    }
    commit(core.setAllDone(state.tasks, done, Date.now()));
    setStatus(done ? "All tasks marked done." : "All tasks marked active.", "ok");
  }

  function clearCompleted() {
    var count = state.tasks.filter(function (t) { return t.done; }).length;
    if (!count) {
      setStatus("No completed tasks to clear.", "error");
      return;
    }
    commit(core.clearCompleted(state.tasks));
    setStatus("Removed " + count + (count === 1 ? " completed task." : " completed tasks."), "ok");
  }

  function resetAll() {
    if (!state.tasks.length) {
      setStatus("There is nothing to delete.", "error");
      return;
    }
    if (!window.confirm("Delete all " + state.tasks.length + " tasks? This cannot be undone.")) return;
    state.tasks = [];
    state.editingId = null;
    persist();
    renderStatusChips();
    render();
    setStatus("All tasks deleted.", "ok");
  }

  // ---------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    return core.todayKey(Date.now());
  }

  function exportJson() {
    if (!state.tasks.length) {
      setStatus("There are no tasks to export.", "error");
      return;
    }
    var text = core.serialize(state.tasks, Date.now());
    downloadBlob(new Blob([text], { type: "application/json" }), "tasks-" + stamp() + ".json");
    setStatus("Exported " + state.tasks.length + " tasks as JSON.", "ok");
  }

  function toMarkdown() {
    var groups = {
      "Overdue": [], "Due today": [], "Upcoming": [], "No due date": [], "Completed": []
    };
    var now = Date.now();
    core.sortTasks(state.tasks, "due", now).forEach(function (t) {
      if (t.done) { groups["Completed"].push(t); return; }
      var s = core.dueStatus(t, now);
      if (s === "overdue") groups["Overdue"].push(t);
      else if (s === "today") groups["Due today"].push(t);
      else if (s === "none") groups["No due date"].push(t);
      else groups["Upcoming"].push(t);
    });

    var lines = ["# Task Board", "", "Exported " + new Date().toISOString().slice(0, 10) + " · " +
      state.tasks.length + " tasks", ""];
    Object.keys(groups).forEach(function (heading) {
      var list = groups[heading];
      if (!list.length) return;
      lines.push("## " + heading, "");
      list.forEach(function (t) {
        var box = t.done ? "[x]" : "[ ]";
        var extra = [];
        if (t.priority !== "normal") extra.push(PRIORITY_LABELS[t.priority].toLowerCase());
        if (t.due) extra.push(t.due);
        if (t.tags.length) extra.push(t.tags.map(function (x) { return "#" + x; }).join(" "));
        lines.push("- " + box + " " + t.title + (extra.length ? "  _(" + extra.join(", ") + ")_" : ""));
        if (t.notes) lines.push("      " + t.notes.replace(/\n/g, " "));
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  function exportMarkdown() {
    if (!state.tasks.length) {
      setStatus("There are no tasks to export.", "error");
      return;
    }
    downloadBlob(new Blob([toMarkdown()], { type: "text/markdown" }), "tasks-" + stamp() + ".md");
    setStatus("Exported tasks as Markdown.", "ok");
  }

  function copyMarkdown() {
    if (!state.tasks.length) {
      setStatus("There are no tasks to copy.", "error");
      return;
    }
    var text = toMarkdown();
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      setStatus("The clipboard API is unavailable here. Use “Export Markdown” instead.", "error");
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      setStatus("Markdown copied to the clipboard.", "ok");
    }).catch(function () {
      setStatus("Copy was blocked by the browser. Use “Export Markdown” instead.", "error");
    });
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setStatus("That file is larger than 20 MB. Task boards should be much smaller than that.", "error");
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      setStatus("The file could not be read.", "error");
    };
    reader.onload = function () {
      var result = core.deserialize(String(reader.result), Date.now());
      if (!result.ok) {
        setStatus("Import failed: " + result.error, "error");
        return;
      }
      if (!result.tasks.length) {
        setStatus("That file contained no readable tasks.", "error");
        return;
      }
      var replace = true;
      if (state.tasks.length) {
        replace = window.confirm(
          "Replace the " + state.tasks.length + " tasks currently on the board with the " +
          result.tasks.length + " from this file?\n\nChoose Cancel to merge them instead."
        );
      }
      var merged;
      if (replace) {
        merged = result.tasks;
      } else {
        // Merge: keep existing ids, give imported tasks fresh ids to avoid collisions.
        var existing = state.tasks.slice();
        var seen = Object.create(null);
        existing.forEach(function (t) { seen[t.id] = true; });
        var base = existing.reduce(function (m, t) { return Math.max(m, t.order || 0); }, 0);
        result.tasks.forEach(function (t, i) {
          var id = seen[t.id] ? core.makeId() : t.id;
          seen[id] = true;
          existing.push(Object.assign({}, t, { id: id, order: base + i + 1 }));
        });
        merged = core.reindex(existing);
      }
      commit(merged);
      setStatus("Imported " + result.tasks.length + " tasks" + (replace ? "." : " and merged them.") +
        (result.warnings.length ? " " + result.warnings.join(" ") : ""), "ok");
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------
  // Sample board
  // ---------------------------------------------------------------------

  function loadSample() {
    var now = Date.now();
    var day = 86400000;
    var specs = [
      { title: "Draft the Q3 planning doc", priority: "high", tags: "work, writing", due: core.todayKey(now - day) },
      { title: "Reply to design review comments", priority: "high", tags: "work", due: core.todayKey(now) },
      { title: "Book dentist appointment", priority: "normal", tags: "health", due: core.todayKey(now + 2 * day) },
      { title: "Renew domain name", priority: "normal", tags: "admin, work", due: core.todayKey(now + 12 * day) },
      { title: "Read two chapters of the DSP book", priority: "low", tags: "study", due: null, notes: "Chapter 4 and 5, take notes on windowing." },
      { title: "Water the plants", priority: "low", tags: "home", due: null, done: true }
    ];
    var tasks = specs.map(function (spec, i) {
      return core.createTask(spec, { order: i, now: now - (specs.length - i) * 1000 });
    });
    state.tasks = tasks;
    state.editingId = null;
    state.query = { text: "", status: "all", priority: "", tag: "" };
    state.sort = "manual";
    el.search.value = "";
    el.priorityFilter.value = "";
    el.tagFilter.value = "";
    el.sort.value = "manual";
    persist();
    renderStatusChips();
    render();
    setStatus("Loaded a sample board with " + tasks.length + " tasks.", "ok");
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  function cacheElements() {
    el = {
      composer: document.getElementById("composer"),
      titleInput: document.getElementById("f-title"),
      dueInput: document.getElementById("f-due"),
      priorityInput: document.getElementById("f-priority"),
      tagsInput: document.getElementById("f-tags"),
      search: document.getElementById("f-search"),
      priorityFilter: document.getElementById("f-priority-filter"),
      tagFilter: document.getElementById("f-tag-filter"),
      sort: document.getElementById("f-sort"),
      statusChips: document.getElementById("status-chips"),
      taskList: document.getElementById("task-list"),
      listCount: document.getElementById("list-count"),
      emptyState: document.getElementById("empty-state"),
      emptyMessage: document.getElementById("empty-message"),
      stats: document.getElementById("stats"),
      progressValue: document.getElementById("progress-value"),
      progressBar: document.getElementById("progress-bar"),
      status: document.getElementById("status"),
      saveflag: document.getElementById("saveflag"),
      btnSample: document.getElementById("btn-sample"),
      btnClearFilters: document.getElementById("btn-clear-filters"),
      btnAllDone: document.getElementById("btn-all-done"),
      btnAllActive: document.getElementById("btn-all-active"),
      btnClearDone: document.getElementById("btn-clear-done"),
      btnExportJson: document.getElementById("btn-export-json"),
      btnExportMd: document.getElementById("btn-export-md"),
      btnCopyMd: document.getElementById("btn-copy-md"),
      btnImport: document.getElementById("btn-import"),
      btnReset: document.getElementById("btn-reset"),
      fileInput: document.getElementById("file-input")
    };
  }

  function bind() {
    el.composer.addEventListener("submit", addFromForm);

    el.search.addEventListener("input", function () {
      syncQueryFromControls();
      renderList();
    });
    el.priorityFilter.addEventListener("change", function () {
      syncQueryFromControls();
      renderList();
    });
    el.tagFilter.addEventListener("change", function () {
      syncQueryFromControls();
      renderList();
    });
    el.sort.addEventListener("change", function () {
      syncQueryFromControls();
      renderList();
    });
    el.btnClearFilters.addEventListener("click", clearFilters);

    el.taskList.addEventListener("click", handleListClick);
    el.taskList.addEventListener("change", handleListChange);
    el.taskList.addEventListener("submit", handleEditorSubmit);
    el.taskList.addEventListener("keydown", handleListKeydown);
    el.taskList.addEventListener("dragstart", handleDragStart);
    el.taskList.addEventListener("dragover", handleDragOver);
    el.taskList.addEventListener("drop", handleDrop);
    el.taskList.addEventListener("dragend", handleDragEnd);
    el.taskList.addEventListener("dragleave", function (event) {
      var li = event.target.closest ? event.target.closest(".task") : null;
      if (li) li.classList.remove("drop-target");
    });

    el.btnSample.addEventListener("click", loadSample);
    el.btnAllDone.addEventListener("click", function () { markAll(true); });
    el.btnAllActive.addEventListener("click", function () { markAll(false); });
    el.btnClearDone.addEventListener("click", clearCompleted);
    el.btnExportJson.addEventListener("click", exportJson);
    el.btnExportMd.addEventListener("click", exportMarkdown);
    el.btnCopyMd.addEventListener("click", copyMarkdown);
    el.btnImport.addEventListener("click", function () { el.fileInput.click(); });
    el.fileInput.addEventListener("change", function () {
      if (el.fileInput.files && el.fileInput.files[0]) importFile(el.fileInput.files[0]);
      el.fileInput.value = "";
    });
    el.btnReset.addEventListener("click", resetAll);

    // Re-evaluate due-date buckets when the day rolls over or the tab returns.
    window.addEventListener("focus", function () { render(); });

    // The save is debounced, so flush it before the page can go away. Without
    // this a quick edit followed by an immediate tab close would be lost.
    window.addEventListener("pagehide", flushPendingSave);
    window.addEventListener("beforeunload", flushPendingSave);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flushPendingSave();
    });
  }

  function flushPendingSave() {
    if (!saveTimer) return;
    window.clearTimeout(saveTimer);
    saveTimer = null;
    persist();
  }

  function init() {
    cacheElements();
    bind();
    loadFromStorage();
    renderStatusChips();
    render();
    // Only offer the "get started" hint when nothing more important was reported
    // (a storage error or a corrupt-payload warning takes precedence).
    if (!state.tasks.length && !storageWarned) {
      setStatus("Your board is empty. Add a task, or load the sample board to explore the tool.", "ok");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
