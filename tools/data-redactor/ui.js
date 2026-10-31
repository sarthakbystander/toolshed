/* Toolshed — Data Redactor UI.
 * Wires the page to window.Toolshed.dataRedactor. All user-derived text is
 * rendered with textContent / createElement — never innerHTML — so pasted
 * content cannot inject markup. No network, no storage.
 */
(function () {
  "use strict";

  var lib = window.Toolshed && window.Toolshed.dataRedactor;
  if (!lib) return;

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    input: $("dr-input"),
    inputMeta: $("dr-input-meta"),
    file: $("dr-file"),
    open: $("dr-open"),
    sample: $("dr-sample"),
    clear: $("dr-clear"),
    scan: $("dr-scan"),
    redact: $("dr-redact"),
    status: $("dr-status"),
    strategy: $("dr-strategy"),
    strategyHelp: $("dr-strategy-help"),
    maskField: $("dr-mask-field"),
    maskKeep: $("dr-mask-keep"),
    saltField: $("dr-salt-field"),
    salt: $("dr-salt"),
    terms: $("dr-terms"),
    groups: $("dr-groups"),
    allOn: $("dr-all-on"),
    allOff: $("dr-all-off"),
    reset: $("dr-reset"),
    results: $("dr-results"),
    kpis: $("dr-kpis"),
    output: $("dr-output"),
    outputTitle: $("dr-output-title"),
    copy: $("dr-copy"),
    download: $("dr-download"),
    restore: $("dr-restore"),
    copyMd: $("dr-copy-md"),
    copyCsv: $("dr-copy-csv"),
    copyJson: $("dr-copy-json"),
    filter: $("dr-filter"),
    hideValues: $("dr-hide-values"),
    findingsBody: $("dr-findings-body"),
    findingsEmpty: $("dr-findings-empty"),
  };

  var STRATEGY_HELP = {
    redact: "Replaces each value with a typed placeholder. The safest default for sharing.",
    mask: "Keeps a couple of characters at each end so the shape is recognisable. Not reversible, but weak on short values.",
    hash: "A deterministic, salted SHA-256 fingerprint. Same input and salt always produce the same token, so records can be joined without exposing values.",
    tokenize: "Assigns EMAIL_ADDRESS_1, EMAIL_ADDRESS_2, … per distinct value. Reads naturally and keeps repetition visible.",
    remove: "Deletes the value outright, leaving the surrounding text intact.",
  };

  var SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  var SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
  var GROUP_LABEL = { credential: "Credentials & secrets", personal: "Personal data", network: "Network", custom: "Custom terms" };

  var lastResult = null;      // redact() result for the current input
  var showingRedacted = true; // output pane currently shows redacted vs restored text
  var enabledState = lib.defaultOptions();
  var detectorEls = {};

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  function currentOptions() {
    var terms = el.terms.value.split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    return {
      enabled: enabledState,
      strategy: el.strategy.value,
      maskKeep: parseInt(el.maskKeep.value, 10),
      salt: el.salt.value,
      customTerms: terms,
    };
  }

  function syncStrategyFields() {
    var s = el.strategy.value;
    el.maskField.hidden = s !== "mask";
    el.saltField.hidden = s !== "hash";
    el.strategyHelp.textContent = STRATEGY_HELP[s] || "";
  }

  function buildDetectorList() {
    var groups = {};
    lib.listDetectors().forEach(function (d) {
      (groups[d.group] = groups[d.group] || []).push(d);
    });

    Object.keys(groups).forEach(function (groupName) {
      var fieldset = document.createElement("div");
      fieldset.className = "dr-group";

      var heading = document.createElement("div");
      heading.className = "dr-group-head";
      heading.textContent = GROUP_LABEL[groupName] || groupName;
      fieldset.appendChild(heading);

      groups[groupName].forEach(function (d) {
        var row = document.createElement("label");
        row.className = "dr-detector";
        row.title = d.description;

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!enabledState[d.id];
        cb.addEventListener("change", function () { enabledState[d.id] = cb.checked; });
        detectorEls[d.id] = cb;

        var name = document.createElement("span");
        name.className = "dr-detector-name";
        name.textContent = d.label;

        var sev = document.createElement("span");
        sev.className = "dr-sev dr-sev-" + d.severity;
        sev.textContent = SEVERITY_LABEL[d.severity];

        row.appendChild(cb);
        row.appendChild(name);
        if (d.heuristic) {
          var tag = document.createElement("span");
          tag.className = "dr-tag";
          tag.textContent = "heuristic";
          tag.title = "Pattern-based; may miss real values or flag harmless text. Off by default.";
          row.appendChild(tag);
        }
        row.appendChild(sev);
        fieldset.appendChild(row);
      });

      el.groups.appendChild(fieldset);
    });
  }

  function setAllDetectors(value) {
    lib.listDetectors().forEach(function (d) {
      enabledState[d.id] = value;
      if (detectorEls[d.id]) detectorEls[d.id].checked = value;
    });
  }

  // ---------------------------------------------------------------------
  // Status + KPIs
  // ---------------------------------------------------------------------

  function setStatus(message, kind) {
    if (!message) {
      el.status.classList.add("hidden");
      el.status.textContent = "";
      return;
    }
    el.status.textContent = message;
    el.status.classList.remove("hidden", "error", "ok");
    if (kind) el.status.classList.add(kind);
  }

  function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function renderKpis(stats, strategy) {
    el.kpis.textContent = "";
    var items = [
      { label: "Findings", value: formatNumber(stats.total), tone: stats.total ? "accent" : "muted" },
      { label: "Critical", value: formatNumber(stats.bySeverity.critical), tone: "critical" },
      { label: "High", value: formatNumber(stats.bySeverity.high), tone: "high" },
      { label: "Medium", value: formatNumber(stats.bySeverity.medium), tone: "medium" },
      { label: "Low", value: formatNumber(stats.bySeverity.low), tone: "low" },
      { label: "Characters replaced", value: formatNumber(stats.redactedChars), tone: "muted" },
      { label: "Strategy", value: strategy, tone: "muted" },
    ];
    items.forEach(function (item) {
      var card = document.createElement("div");
      card.className = "dr-kpi dr-kpi-" + item.tone;
      var v = document.createElement("span");
      v.className = "dr-kpi-value";
      v.textContent = item.value;
      var l = document.createElement("span");
      l.className = "dr-kpi-label";
      l.textContent = item.label;
      card.appendChild(v);
      card.appendChild(l);
      el.kpis.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------
  // Findings table
  // ---------------------------------------------------------------------

  function renderFindings() {
    var body = el.findingsBody;
    body.textContent = "";
    if (!lastResult) return;

    var needle = el.filter.value.trim().toLowerCase();
    var hide = el.hideValues.checked;
    var rows = lastResult.findings.filter(function (f) {
      if (!needle) return true;
      return f.value.toLowerCase().indexOf(needle) !== -1 ||
        f.label.toLowerCase().indexOf(needle) !== -1 ||
        f.type.toLowerCase().indexOf(needle) !== -1;
    });

    rows.sort(function (a, b) {
      var sa = SEVERITY_ORDER[a.severity], sb = SEVERITY_ORDER[b.severity];
      return sa - sb || a.start - b.start;
    });

    rows.forEach(function (f) {
      var tr = document.createElement("tr");

      var tdType = document.createElement("td");
      tdType.textContent = f.label;
      if (f.heuristic) {
        var tag = document.createElement("span");
        tag.className = "dr-tag";
        tag.textContent = "heuristic";
        tdType.appendChild(document.createTextNode(" "));
        tdType.appendChild(tag);
      }

      var tdSev = document.createElement("td");
      var sev = document.createElement("span");
      sev.className = "dr-sev dr-sev-" + f.severity;
      sev.textContent = SEVERITY_LABEL[f.severity];
      tdSev.appendChild(sev);

      var tdStart = document.createElement("td");
      tdStart.className = "dr-num";
      tdStart.textContent = formatNumber(f.start);

      var tdValue = document.createElement("td");
      tdValue.className = "dr-value";
      tdValue.textContent = hide ? "\u2022\u2022\u2022 hidden \u2022\u2022\u2022" : f.value;
      if (hide) tdValue.classList.add("dr-value-hidden");

      var tdRepl = document.createElement("td");
      tdRepl.className = "dr-value";
      tdRepl.textContent = f.replacement === "" ? "(removed)" : f.replacement;

      tr.appendChild(tdType);
      tr.appendChild(tdSev);
      tr.appendChild(tdStart);
      tr.appendChild(tdValue);
      tr.appendChild(tdRepl);
      body.appendChild(tr);
    });

    el.findingsEmpty.hidden = rows.length > 0;
  }

  // ---------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------

  function run(mode) {
    var text = el.input.value;
    if (!text) {
      setStatus("Nothing to scan — paste some text first.", "error");
      el.results.hidden = true;
      lastResult = null;
      return;
    }

    var opts = currentOptions();
    var result;
    if (mode === "scan") {
      var scanned = lib.scan(text, opts);
      result = { ok: true, text: text, findings: scanned.findings, stats: scanned.stats, mapping: [], strategy: null };
    } else {
      result = lib.redact(text, opts);
    }

    if (!result.ok) {
      setStatus(result.error || "Could not process the input.", "error");
      el.results.hidden = true;
      lastResult = null;
      return;
    }

    lastResult = result;
    showingRedacted = true;
    el.results.hidden = false;
    el.output.value = result.text;
    el.outputTitle.textContent = mode === "scan" ? "SOURCE (UNCHANGED)" : "REDACTED OUTPUT";
    el.restore.disabled = mode === "scan" || result.mapping.length === 0;
    el.restore.textContent = "Restore originals";

    renderKpis(result.stats, mode === "scan" ? "scan only" : result.strategy);
    renderFindings();

    if (result.stats.total === 0) {
      setStatus("No sensitive values detected. Review the detector list if you expected something to be found.", "ok");
    } else if (mode === "scan") {
      setStatus("Found " + result.stats.total + " sensitive value" + (result.stats.total === 1 ? "" : "s") + ". Nothing was changed.", "ok");
    } else {
      setStatus("Redacted " + result.stats.total + " value" + (result.stats.total === 1 ? "" : "s") + " with the " + result.strategy + " strategy.", "ok");
    }
  }

  // ---------------------------------------------------------------------
  // Clipboard + download
  // ---------------------------------------------------------------------

  function copyText(text, button, label) {
    if (!navigator.clipboard) {
      setStatus("Clipboard API unavailable in this browser. Select the text and copy manually.", "error");
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      var original = button.textContent;
      button.textContent = "Copied \u2713";
      setTimeout(function () { button.textContent = original; }, 1500);
      if (label) setStatus(label, "ok");
    }).catch(function () {
      setStatus("Copy was blocked by the browser. Select the text and copy with Ctrl/Cmd+C.", "error");
    });
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------------------------------------------------------------
  // Sample + file loading
  // ---------------------------------------------------------------------

  var SAMPLE = [
    "2024-05-01T10:00:00Z INFO  api.handler: login ok user=ada.lovelace@example.com from 203.0.113.7",
    "2024-05-01T10:00:01Z ERROR billing: charge failed card=4111 1111 1111 1111 for customer Ada Lovelace",
    "2024-05-01T10:00:02Z DEBUG config: loaded DATABASE_URL=postgres://svc_user:pgP4ssw0rd!@db.internal:5432/app",
    "2024-05-01T10:00:03Z DEBUG auth: refreshing token ghp_" + "a".repeat(36),
    "2024-05-01T10:00:04Z WARN  http: inbound Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature",
    "2024-05-01T10:00:05Z INFO  net: peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 mac 00:1A:2B:3C:4D:5E",
    "2024-05-01T10:00:06Z INFO  kyc: customer ssn 123-45-6789, iban GB82 WEST 1234 5698 7654 32",
    "2024-05-01T10:00:07Z DEBUG env: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "2024-05-01T10:00:08Z INFO  misc: version 1.2.3 on port 8080, 1200 requests/min",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAx9F2kQ...redacted-for-the-sample...",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  el.strategy.addEventListener("change", syncStrategyFields);
  el.maskKeep.addEventListener("input", function () {
    var v = parseInt(el.maskKeep.value, 10);
    if (isNaN(v) || v < 0) el.maskKeep.value = "0";
    if (v > 8) el.maskKeep.value = "8";
  });
  el.allOn.addEventListener("click", function () { setAllDetectors(true); });
  el.allOff.addEventListener("click", function () { setAllDetectors(false); });

  el.reset.addEventListener("click", function () {
    el.strategy.value = "redact";
    el.maskKeep.value = "2";
    el.salt.value = "";
    el.terms.value = "";
    enabledState = lib.defaultOptions();
    Object.keys(detectorEls).forEach(function (id) { detectorEls[id].checked = enabledState[id]; });
    syncStrategyFields();
    setStatus("Settings reset to defaults.", "ok");
  });

  el.scan.addEventListener("click", function () { run("scan"); });
  el.redact.addEventListener("click", function () { run("redact"); });

  el.input.addEventListener("input", function () {
    var n = el.input.value.length;
    el.inputMeta.textContent = formatNumber(n) + " character" + (n === 1 ? "" : "s");
  });

  el.input.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run("redact");
    }
  });

  el.sample.addEventListener("click", function () {
    el.input.value = SAMPLE;
    el.inputMeta.textContent = formatNumber(SAMPLE.length) + " characters";
    run("redact");
  });

  el.open.addEventListener("click", function () { el.file.click(); });

  el.file.addEventListener("change", function () {
    var f = el.file.files && el.file.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      setStatus("That file is larger than 5 MB. Open it in a text editor and paste the part you need.", "error");
      el.file.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      el.input.value = String(reader.result);
      el.inputMeta.textContent = formatNumber(el.input.value.length) + " characters";
      run("redact");
    };
    reader.onerror = function () {
      setStatus("Could not read that file.", "error");
    };
    reader.readAsText(f);
    el.file.value = "";
  });

  // Drag and drop onto the source pane.
  ["dragover", "drop"].forEach(function (evt) {
    el.input.addEventListener(evt, function (e) {
      if (evt === "dragover") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) {
        setStatus("That file is larger than 5 MB. Paste the relevant section instead.", "error");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        el.input.value = String(reader.result);
        el.inputMeta.textContent = formatNumber(el.input.value.length) + " characters";
        run("redact");
      };
      reader.readAsText(f);
    });
  });

  el.clear.addEventListener("click", function () {
    el.input.value = "";
    el.output.value = "";
    el.inputMeta.textContent = "0 characters";
    el.results.hidden = true;
    lastResult = null;
    setStatus("");
    el.input.focus();
  });

  el.copy.addEventListener("click", function () {
    copyText(el.output.value, el.copy, "Redacted output copied to clipboard.");
  });

  el.download.addEventListener("click", function () {
    download("redacted-output.txt", el.output.value);
    setStatus("Downloaded redacted-output.txt.", "ok");
  });

  el.restore.addEventListener("click", function () {
    if (!lastResult) return;
    if (showingRedacted) {
      el.output.value = lib.restore(el.output.value, lastResult.mapping);
      el.outputTitle.textContent = "RESTORED (ORIGINAL VALUES)";
      el.restore.textContent = "Show redacted";
      showingRedacted = false;
      setStatus("Original values restored in the output pane. Nothing left this tab.", "ok");
    } else {
      el.output.value = lastResult.text;
      el.outputTitle.textContent = "REDACTED OUTPUT";
      el.restore.textContent = "Restore originals";
      showingRedacted = true;
      setStatus("Showing redacted output.", "ok");
    }
  });

  el.copyMd.addEventListener("click", function () {
    if (!lastResult) return;
    copyText(lib.toMarkdownReport(lastResult), el.copyMd, "Markdown report copied.");
  });
  el.copyCsv.addEventListener("click", function () {
    if (!lastResult) return;
    copyText(lib.toCSVReport(lastResult.findings, { includeOriginals: !el.hideValues.checked }), el.copyCsv, "CSV report copied.");
  });
  el.copyJson.addEventListener("click", function () {
    if (!lastResult) return;
    copyText(lib.toJSONReport(lastResult, { includeOriginals: !el.hideValues.checked }), el.copyJson, "JSON report copied.");
  });

  el.filter.addEventListener("input", renderFindings);
  el.hideValues.addEventListener("change", renderFindings);

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  buildDetectorList();
  syncStrategyFields();
  el.inputMeta.textContent = "0 characters";
  setStatus("Paste text and press Redact — or load the sample to see it in action.");
})();
