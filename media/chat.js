(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  let currentAssistant = null;
  let hasMessages = false;

  // ---- 迷你富文本渲染：代码围栏、行内代码、加粗（零依赖，CSP 安全） ----

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderInline(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderRich(el, text) {
    el.innerHTML = '';
    const parts = text.split('```');
    parts.forEach(function (part, i) {
      if (i % 2 === 1) {
        let code = part;
        const nl = part.indexOf('\n');
        if (nl > 0 && nl <= 20 && !part.slice(0, nl).includes(' ')) {
          code = part.slice(nl + 1); // 首行是语言标记
        }
        const pre = document.createElement('pre');
        pre.className = 'code-block';
        pre.textContent = code.replace(/\n$/, '');
        el.appendChild(pre);
      } else if (part.trim()) {
        const div = document.createElement('div');
        div.className = 'rich-text';
        div.innerHTML = renderInline(escapeHtml(part));
        el.appendChild(div);
      }
    });
  }

  // ---- 消息流 ----

  function removeEmptyHint() {
    if (!hasMessages) {
      const hint = messages.querySelector('.empty-hint');
      if (hint) {
        hint.remove();
      }
      hasMessages = true;
    }
  }

  function showEmptyHint() {
    messages.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.innerHTML =
      '<div class="empty-icon">🐾</div>' +
      '<div class="empty-title">Your pair partner is ready</div>' +
      '<div class="empty-tips">I analyze your code as you write and offer suggestions<br>First time? Click "Init" above so I can get familiar with the project<br>You can interrupt me anytime while I work</div>';
    messages.appendChild(hint);
    hasMessages = false;
    currentAssistant = null;
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addBubble(cls, text) {
    removeEmptyHint();
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    messages.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addToolCard(name, text, isResult) {
    removeEmptyHint();
    const d = document.createElement('details');
    d.className = 'msg tool';
    const sum = document.createElement('summary');
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = isResult ? '✔' : '⚙';
    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = name + (isResult ? ' · result' : '');
    sum.appendChild(icon);
    sum.appendChild(label);
    const pre = document.createElement('pre');
    pre.textContent = text;
    d.appendChild(sum);
    d.appendChild(pre);
    messages.appendChild(d);
    scrollToBottom();
  }

  // ---- 思考流（推理模型的 reasoning_content）：流式时展开，说完自动折叠 ----

  let currentReasoning = null; // {details, pre, label}

  function addReasoningBlock() {
    removeEmptyHint();
    const d = document.createElement('details');
    d.className = 'msg reasoning';
    d.open = true;
    const sum = document.createElement('summary');
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = '💭';
    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = 'Thinking…';
    sum.appendChild(icon);
    sum.appendChild(label);
    const pre = document.createElement('pre');
    d.appendChild(sum);
    d.appendChild(pre);
    messages.appendChild(d);
    scrollToBottom();
    return { details: d, pre: pre, label: label };
  }

  // 思考段结束（开始说话/调工具/收尾）：折叠收起，标题从进行时变过去式
  function finishReasoning() {
    if (currentReasoning) {
      currentReasoning.details.open = false;
      currentReasoning.label.textContent = 'Thought process';
      currentReasoning = null;
    }
  }

  function addConfirmBubble(id, action, detail) {
    removeEmptyHint();
    const div = document.createElement('div');
    div.className = 'msg confirm';

    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = '⚠️ Approval needed · ' + action;
    div.appendChild(title);

    const detailEl = document.createElement('pre');
    detailEl.className = 'detail';
    detailEl.textContent = detail;
    div.appendChild(detailEl);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.className = 'btn-approve';
    approve.textContent = '✓ Approve';

    const reject = document.createElement('button');
    reject.className = 'btn-reject';
    reject.textContent = '✕ Reject';

    function respond(approved) {
      vscode.postMessage({ type: 'approve', id: id, approved: approved });
      actions.remove();
      title.textContent = (approved ? '✓ Approved · ' : '✕ Rejected · ') + action;
      div.classList.add(approved ? 'approved' : 'rejected');
    }

    approve.addEventListener('click', function () { respond(true); });
    reject.addEventListener('click', function () { respond(false); });

    actions.appendChild(approve);
    actions.appendChild(reject);
    div.appendChild(actions);
    messages.appendChild(div);
    scrollToBottom();
  }

  function addChoiceBubble(id, question, options) {
    removeEmptyHint();
    const div = document.createElement('div');
    div.className = 'msg confirm choice';

    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = '💬 ' + question;
    div.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'actions choice-actions';

    const custom = document.createElement('input');
    custom.className = 'choice-custom';
    custom.placeholder = 'Or type your answer and press Enter…';

    function respond(answer) {
      vscode.postMessage({ type: 'choiceAnswer', id: id, answer: answer });
      actions.remove();
      custom.remove();
      const picked = document.createElement('div');
      picked.className = 'choice-picked';
      picked.textContent = '→ ' + answer;
      div.appendChild(picked);
      div.classList.add('approved');
    }

    const letters = 'ABCDEFGH';
    options.forEach(function (opt, i) {
      const btn = document.createElement('button');
      btn.className = 'btn-choice';

      const badge = document.createElement('span');
      badge.className = 'choice-letter';
      badge.textContent = letters[i];
      btn.appendChild(badge);

      const text = document.createElement('span');
      text.className = 'choice-text';
      const label = document.createElement('span');
      label.className = 'choice-label';
      label.textContent = opt.label;
      text.appendChild(label);
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'choice-desc';
        desc.textContent = opt.description;
        text.appendChild(desc);
      }
      btn.appendChild(text);

      btn.addEventListener('click', function () {
        respond(letters[i] + '. ' + opt.label + (opt.description ? '（' + opt.description + '）' : ''));
      });
      actions.appendChild(btn);
    });

    custom.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && custom.value.trim()) {
        respond(custom.value.trim());
      }
    });

    div.appendChild(actions);
    div.appendChild(custom);
    messages.appendChild(div);
    scrollToBottom();
    custom.focus();
  }

  function setBusy(busy) {
    sendBtn.disabled = false;
    sendBtn.textContent = busy ? '■' : '➤';
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.classList.toggle('stopping', busy);
    input.disabled = false;
    if (!busy) {
      input.focus();
    }
  }

  // ---- 引用建议：点卡片上的 💬 把这条挂到输入框，发送时一起带给模型 ----

  const quoteChip = document.getElementById('quote-chip');
  let pendingQuote = null; // {title, body}

  function setQuote(title, body) {
    pendingQuote = { title: title, body: (body || '').slice(0, 500) };
    quoteChip.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'quote-label';
    label.textContent = '💬 ' + title;
    const close = document.createElement('button');
    close.className = 'quote-close';
    close.textContent = '✕';
    close.title = 'Remove quote';
    close.addEventListener('click', clearQuote);
    quoteChip.appendChild(label);
    quoteChip.appendChild(close);
    quoteChip.classList.remove('hidden');
    input.focus();
  }

  function clearQuote() {
    pendingQuote = null;
    quoteChip.classList.add('hidden');
    quoteChip.innerHTML = '';
  }

  function send() {
    // 运行中：空输入点 ■ = 叫停；有文字 = 打断当前任务并插话
    if (sendBtn.classList.contains('stopping') && !input.value.trim()) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }
    let outgoing = text;
    let display = text;
    if (pendingQuote) {
      // 引用随消息一起发给模型，指代从「猜」变成显式；气泡里显示引用摘要
      outgoing =
        text +
        '\n\n（我在问面板里的这条：「' +
        pendingQuote.title +
        '」' +
        (pendingQuote.body ? '\n' + pendingQuote.body : '') +
        '）';
      display = '💬 ' + pendingQuote.title + '\n' + text;
      clearQuote();
    }
    addBubble('user', display);
    vscode.postMessage({ type: 'send', text: outgoing });
    input.value = '';
    currentAssistant = null;
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  document.getElementById('clear-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'clear' });
  });
  document.getElementById('settings-btn').addEventListener('click', function () {
    toggleSettings();
  });
  document.getElementById('logs-btn').addEventListener('click', function () {
    toggleActivity();
  });
  document.getElementById('init-btn').addEventListener('click', function () {
    addBubble('user', 'Get familiar with this project and build the initial memory.');
    vscode.postMessage({ type: 'initProject' });
    currentAssistant = null;
  });
  document.getElementById('analyze-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'analyzeNow' });
  });

  // ---- 底部快选：模型 / 权限（改动直接写配置，设置页保存后也会回推同步） ----

  const modelSelect = document.getElementById('model-select');
  const permissionSelect = document.getElementById('permission-select');

  function syncQuickControls(s) {
    const models = [];
    for (const key in PROVIDERS) {
      if (models.indexOf(PROVIDERS[key].model) < 0) {
        models.push(PROVIDERS[key].model);
      }
    }
    if (s.model && models.indexOf(s.model) < 0) {
      models.push(s.model);
    }
    modelSelect.innerHTML = '';
    models.forEach(function (m) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    });
    modelSelect.value = s.model || '';
    permissionSelect.value = s.permissionMode || 'ask';
    learnBtn.textContent = 'Learn·' + (s.learningMode ? 'On' : 'Off');
    learnBtn.classList.toggle('off', !s.learningMode);
  }

  modelSelect.addEventListener('change', function () {
    vscode.postMessage({ type: 'setModel', text: modelSelect.value });
  });
  permissionSelect.addEventListener('change', function () {
    vscode.postMessage({ type: 'setPermissionMode', text: permissionSelect.value });
  });

  const companionBtn = document.getElementById('companion-btn');
  companionBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'toggleCompanion' });
  });

  const learnBtn = document.getElementById('learn-btn');
  learnBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'toggleLearning' });
  });

  const suggestions = new Map();

  function buildSuggestionCard(headerText) {
    removeEmptyHint();
    const div = document.createElement('div');
    div.className = 'msg suggestion';
    const header = document.createElement('div');
    header.className = 'suggestion-header';
    const headerLabel = document.createElement('span');
    headerLabel.className = 'header-label';
    headerLabel.textContent = headerText;
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'quote-btn';
    quoteBtn.textContent = 'Discuss';
    quoteBtn.title = 'Ask the AI about this (quotes it into the input box)';
    header.appendChild(headerLabel);
    header.appendChild(quoteBtn);
    div.appendChild(header);
    const body = document.createElement('div');
    body.className = 'suggestion-body';
    div.appendChild(body);
    quoteBtn.addEventListener('click', function () {
      setQuote(headerLabel.textContent, body.textContent);
    });
    messages.appendChild(div);
    scrollToBottom();
    return { div: div, header: header, headerLabel: headerLabel, body: body };
  }

  function onSuggestionStart(id, file, label) {
    const entry = buildSuggestionCard(label || '💡 Analyzing ' + file + '…');
    entry.div.classList.add('thinking');
    suggestions.set(id, entry);
  }

  function onSuggestionEnd(id, file, content) {
    const entry = suggestions.get(id);
    suggestions.delete(id);
    if (!entry) {
      return;
    }
    entry.div.classList.remove('thinking');
    if (!content) {
      entry.div.remove();
      return;
    }
    entry.headerLabel.textContent = '💡 Suggestions for ' + file;
    renderRich(entry.body, content);
    scrollToBottom();
  }

  // 建议详情卡（帮助阶梯的展示层）：detail 直接给，reflect 随行；
  // fix 在 masked（学习模式且非 L3）时藏起，点「直接给方案」本地拉开；
  // 展开说说 / 给个例子是按需深化，发给扩展端现场生成
  function renderSuggestionCard(m) {
    const entry = buildSuggestionCard(m.title);
    renderRich(entry.body, m.detail || '');
    if (m.reflect) {
      const r = document.createElement('div');
      r.className = 'reflect-line';
      r.textContent = '🪞 ' + m.reflect;
      entry.body.appendChild(r);
    }
    const row = document.createElement('div');
    row.className = 'ladder-row';
    function deepenBtn(kind, label) {
      const btn = document.createElement('button');
      btn.className = 'quote-btn';
      btn.textContent = label;
      btn.title = 'Generate on demand (one LLM call)';
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'deepenSuggestion', uriStr: m.uriStr, index: m.index, kind: kind });
        btn.disabled = true;
        btn.textContent = label + '…';
      });
      row.appendChild(btn);
    }
    deepenBtn('explain', '展开说说');
    deepenBtn('example', '给个例子');
    if (m.fix) {
      if (m.masked) {
        const fixDiv = document.createElement('div');
        fixDiv.className = 'hidden';
        renderRich(fixDiv, 'Suggested fix:\n```\n' + m.fix + '\n```');
        entry.body.appendChild(fixDiv);
        const reveal = document.createElement('button');
        reveal.className = 'quote-btn';
        reveal.textContent = '直接给方案';
        reveal.title = 'Reveal the suggested fix (local, no LLM call)';
        reveal.addEventListener('click', function () {
          // 本地动作不产生 LLM 调用，埋点必须主动回传，否则 transcript 里看不到这次「投降」
          vscode.postMessage({ type: 'uiEvent', name: 'fix_revealed', uriStr: m.uriStr, index: m.index });
          fixDiv.classList.remove('hidden');
          reveal.remove();
          scrollToBottom();
        });
        row.appendChild(reveal);
      } else {
        const fixDiv = document.createElement('div');
        renderRich(fixDiv, 'Suggested fix:\n```\n' + m.fix + '\n```');
        entry.body.appendChild(fixDiv);
      }
    }
    entry.body.appendChild(row);
    scrollToBottom();
  }

  // ---- 设置视图（对齐 Cline：Webview 内配置，key 直写 SecretStorage） ----

  const PROVIDERS = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  };

  const settingsView = document.getElementById('settings-view');
  const setProvider = document.getElementById('set-provider');
  const setBaseUrl = document.getElementById('set-baseurl');
  const setModel = document.getElementById('set-model');
  const setApiKey = document.getElementById('set-apikey');
  const setCompanion = document.getElementById('set-companion');
  const setDebounce = document.getElementById('set-debounce');
  const setQuick = document.getElementById('set-quick');
  const setCooldown = document.getElementById('set-cooldown');
  const setPermission = document.getElementById('set-permission');
  const setLanguage = document.getElementById('set-language');
  const setLearning = document.getElementById('set-learning');
  const settingsStatus = document.getElementById('settings-status');

  let settingsOpen = false;

  function toggleSettings(open) {
    settingsOpen = open === undefined ? !settingsOpen : open;
    settingsView.classList.toggle('hidden', !settingsOpen);
    if (settingsOpen) {
      settingsStatus.textContent = '';
      vscode.postMessage({ type: 'getSettings' });
    }
  }

  setProvider.addEventListener('change', function () {
    const preset = PROVIDERS[setProvider.value];
    if (preset) {
      setBaseUrl.value = preset.baseUrl;
      setModel.value = preset.model;
    }
  });

  function detectProvider(baseUrl) {
    for (const key in PROVIDERS) {
      if (PROVIDERS[key].baseUrl === baseUrl) {
        return key;
      }
    }
    return 'custom';
  }

  function fillSettings(s) {
    setBaseUrl.value = s.baseUrl || '';
    setModel.value = s.model || '';
    setApiKey.value = s.apiKey || '';
    setCompanion.checked = !!s.companionEnabled;
    setDebounce.value = s.debounceSeconds || 10;
    setQuick.value = s.quickTriggerSeconds || 3;
    setCooldown.value = s.cooldownSeconds || 300;
    setPermission.value = s.permissionMode || 'ask';
    setLanguage.value = s.responseLanguage || 'zh';
    setLearning.checked = !!s.learningMode;
    setProvider.value = detectProvider(s.baseUrl);
  }

  document.getElementById('settings-save').addEventListener('click', function () {
    vscode.postMessage({
      type: 'saveSettings',
      settings: {
        baseUrl: setBaseUrl.value,
        model: setModel.value,
        apiKey: setApiKey.value,
        companionEnabled: setCompanion.checked,
        debounceSeconds: Number(setDebounce.value),
        quickTriggerSeconds: Number(setQuick.value),
        cooldownSeconds: Number(setCooldown.value),
        permissionMode: setPermission.value,
        responseLanguage: setLanguage.value,
        learningMode: setLearning.checked,
      },
    });
  });

  document.getElementById('settings-cancel').addEventListener('click', function () {
    toggleSettings(false);
  });

  // ---- Activity 视图：统一事件流（logger ring buffer），按轨道过滤、按 turnId 分组 ----

  const activityView = document.getElementById('activity-view');
  const activityList = document.getElementById('activity-list');
  let activityOpen = false;
  let activityFilter = 'all';
  let activityEntries = [];
  const ACTIVITY_CAP = 1000;

  function toggleActivity(open) {
    activityOpen = open === undefined ? !activityOpen : open;
    activityView.classList.toggle('hidden', !activityOpen);
    if (activityOpen) {
      vscode.postMessage({ type: 'getActivityLog' });
    }
  }

  function activityMatches(entry) {
    return activityFilter === 'all' || entry.track === activityFilter;
  }

  function entrySummary(entry) {
    if (typeof entry.summary === 'string') {
      return entry.summary;
    }
    try {
      return JSON.stringify(entry).slice(0, 160);
    } catch (e) {
      return '';
    }
  }

  function buildActivityRow(entry) {
    const d = document.createElement('details');
    d.className = 'act-row track-' + (entry.track || 'system');
    const sum = document.createElement('summary');
    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = typeof entry.ts === 'string' ? entry.ts.slice(11, 19) : '';
    const kind = document.createElement('span');
    kind.className = 'act-kind';
    kind.textContent = entry.kind + (entry.phase ? '·' + entry.phase : '');
    const text = document.createElement('span');
    text.className = 'act-summary';
    text.textContent = entrySummary(entry);
    sum.appendChild(time);
    sum.appendChild(kind);
    sum.appendChild(text);
    const pre = document.createElement('pre');
    try {
      pre.textContent = JSON.stringify(entry, null, 2);
    } catch (e) {
      pre.textContent = String(entry);
    }
    d.appendChild(sum);
    d.appendChild(pre);
    return d;
  }

  // turnId 变化时插一个组头：把「一次闭环」的事件在视觉上圈出来；学习模式徽章随行
  function buildGroupHeader(entry) {
    const h = document.createElement('div');
    h.className = 'act-group';
    h.textContent = entry.turnId;
    if (entry.learningMode === true) {
      const badge = document.createElement('span');
      badge.className = 'act-badge';
      badge.textContent = 'Learn';
      h.appendChild(badge);
    }
    return h;
  }

  function appendActivityEntry(entry) {
    const prev = activityEntries[activityEntries.length - 2]; // push 之前的最后一条
    if (entry.turnId && (!prev || prev.turnId !== entry.turnId)) {
      activityList.appendChild(buildGroupHeader(entry));
    }
    activityList.appendChild(buildActivityRow(entry));
    activityList.scrollTop = activityList.scrollHeight;
  }

  function renderActivity() {
    activityList.innerHTML = '';
    let lastTurnId = null;
    activityEntries.forEach(function (entry) {
      if (!activityMatches(entry)) {
        return;
      }
      if (entry.turnId && entry.turnId !== lastTurnId) {
        activityList.appendChild(buildGroupHeader(entry));
      }
      lastTurnId = entry.turnId || lastTurnId;
      activityList.appendChild(buildActivityRow(entry));
    });
    activityList.scrollTop = activityList.scrollHeight;
  }

  document.getElementById('activity-close').addEventListener('click', function () {
    toggleActivity(false);
  });
  document.getElementById('activity-open-logs').addEventListener('click', function () {
    vscode.postMessage({ type: 'openLogs' });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#activity-filters .chip'), function (chip) {
    chip.addEventListener('click', function () {
      activityFilter = chip.dataset.track;
      Array.prototype.forEach.call(document.querySelectorAll('#activity-filters .chip'), function (c) {
        c.classList.toggle('active', c === chip);
      });
      renderActivity();
    });
  });

  // ---- 扩展端消息 ----

  window.addEventListener('message', function (e) {
    const msg = e.data;
    switch (msg.type) {
      case 'token':
        if (!currentAssistant) {
          currentAssistant = addBubble('assistant', '');
          currentAssistant.dataset.raw = '';
        }
        currentAssistant.dataset.raw += msg.text;
        renderRich(currentAssistant, currentAssistant.dataset.raw);
        scrollToBottom();
        break;
      case 'reasoning':
        if (!currentReasoning) {
          currentReasoning = addReasoningBlock();
        }
        currentReasoning.pre.textContent += msg.text;
        scrollToBottom();
        break;
      case 'toolStart':
        finishReasoning();
        addToolCard(msg.name, msg.args, false);
        currentAssistant = null;
        break;
      case 'toolResult':
        addToolCard(msg.name, msg.result, true);
        currentAssistant = null;
        break;
      case 'confirm':
        finishReasoning();
        addConfirmBubble(msg.id, msg.action, msg.detail);
        currentAssistant = null;
        break;
      case 'choice':
        finishReasoning();
        addChoiceBubble(msg.id, msg.question, msg.options || []);
        currentAssistant = null;
        break;
      case 'done':
        finishReasoning();
        currentAssistant = null;
        break;
      case 'interrupted': {
        finishReasoning();
        const entry = buildSuggestionCard('⏹ Stopped');
        entry.body.textContent = '(was ' + (msg.activity || 'composing reply') + ') — go ahead, I am listening.';
        scrollToBottom();
        currentAssistant = null;
        break;
      }
      case 'error':
        finishReasoning();
        addBubble('error', msg.message);
        currentAssistant = null;
        break;
      case 'busy':
        setBusy(msg.busy);
        break;
      case 'suggestionStart':
        onSuggestionStart(msg.id, msg.file, msg.label);
        currentAssistant = null;
        break;
      case 'suggestionEnd':
        onSuggestionEnd(msg.id, msg.file, msg.content);
        currentAssistant = null;
        break;
      case 'note': {
        const entry = buildSuggestionCard(msg.title);
        renderRich(entry.body, msg.text);
        scrollToBottom();
        currentAssistant = null;
        break;
      }
      case 'suggestionCard':
        renderSuggestionCard(msg);
        currentAssistant = null;
        break;
      case 'companionState':
        companionBtn.textContent = 'Watch·' + (msg.enabled ? 'On' : 'Off');
        companionBtn.classList.toggle('off', !msg.enabled);
        break;
      case 'usage': {
        const stats = document.getElementById('usage-stats');
        const s = msg.session;
        if (!s || s.calls === 0) {
          break;
        }
        const fmt = function (n) {
          return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
        };
        stats.textContent = '⇅ ' + fmt(s.total);
        stats.title =
          'This session: in ' + fmt(s.prompt) + ' / out ' + fmt(s.completion) + ' (' + s.calls + ' calls)\n' +
          'Breakdown: chat ' + fmt(msg.bySource.chat.prompt + msg.bySource.chat.completion) +
          ' · watch ' + fmt(msg.bySource.companion.prompt + msg.bySource.companion.completion) +
          ' · compact ' + fmt(msg.bySource.compact.prompt + msg.bySource.compact.completion) + '\n' +
          'All time: ' + fmt(msg.allTime.prompt + msg.allTime.completion) + ' tokens (' + msg.allTime.calls + ' calls)\n' +
          'Note: some gateways do not report usage; those calls are not counted';
        break;
      }
      case 'settings':
        fillSettings(msg.settings);
        syncQuickControls(msg.settings);
        break;
      case 'settingsSaved':
        settingsStatus.textContent = '✓ Saved';
        setTimeout(function () {
          toggleSettings(false);
        }, 800);
        break;
      case 'setQuote':
        setQuote(msg.title, msg.body || '');
        break;
      case 'activityLog':
        activityEntries = msg.entries || [];
        if (activityOpen) {
          renderActivity();
        }
        break;
      case 'activityEvent': {
        if (!msg.entry) {
          break;
        }
        activityEntries.push(msg.entry);
        if (activityEntries.length > ACTIVITY_CAP) {
          activityEntries.splice(0, activityEntries.length - ACTIVITY_CAP);
        }
        if (activityOpen && activityMatches(msg.entry)) {
          appendActivityEntry(msg.entry);
        }
        break;
      }
      case 'cleared':
        showEmptyHint();
        setBusy(false);
        break;
    }
  });

  showEmptyHint();
  vscode.postMessage({ type: 'ready' });
})();
