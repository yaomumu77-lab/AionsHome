(function () {
  const $ = (id) => document.getElementById(id);
  const assetBase = "/public/去约会小剧场素材";
  const DEFAULT_MUSIC_VOLUME = 25;

  function clampPercent(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(100, num));
  }

  function initialMusicVolumePercent() {
    const stored = localStorage.getItem("date_music_volume");
    const migrated = localStorage.getItem("date_music_volume_soft_default_v1") === "1";
    let volume = clampPercent(stored || DEFAULT_MUSIC_VOLUME, DEFAULT_MUSIC_VOLUME);
    if (!migrated) {
      if (!stored || stored === "50") volume = DEFAULT_MUSIC_VOLUME;
      localStorage.setItem("date_music_volume_soft_default_v1", "1");
      localStorage.setItem("date_music_volume", String(Math.round(volume)));
    }
    return volume;
  }

  const state = {
    config: {},
    world: { user_name: "用户", ai_name: "AI" },
    assets: { backgrounds: [], states: [], default_background: "背景-客厅", default_state: "平静" },
    models: [],
    chatroomModel: "",
    personaPresets: [],
    sessions: [],
    syncTargets: [],
    outlineGenerating: false,
    statusAnimationTimer: null,
    inSessionList: true,
    session: null,
    messages: [],
    currentTtsUrls: new Map(),
    currentBackground: "背景-客厅",
    currentState: "平静",
    bgLayer: 0,
    actorLayer: 0,
    sending: false,
    videoSound: localStorage.getItem("date_video_sound") === "1",
    videoVolume: Number(localStorage.getItem("date_video_volume") || 40) / 100,
    musicEnabled: localStorage.getItem("date_music_enabled") !== "0",
    musicVolume: initialMusicVolumePercent() / 100,
    ttsEnabled: localStorage.getItem("date_tts_enabled") === "1",
    ttsVoice: localStorage.getItem("date_tts_voice") || "",
    ttsQueue: new Map(),
    ttsPlaying: false,
    currentTtsAudio: null,
    musicAudio: new Audio(),
    musicDucked: false,
    musicExpanded: false,
    reviewing: false,
    reviewTimer: null,
    reviewTimerResolve: null,
    reviewAudio: null,
    reviewAudioResolve: null,
    replayTtsAudio: null,
    actionPickerOpen: false,
  };

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const data = await res.json();
        msg = data.error || msg;
      } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function findBackground(id) {
    return state.assets.backgrounds.find((item) => item.id === id)
      || state.assets.backgrounds.find((item) => item.id === state.assets.default_background)
      || { id: "背景-客厅", name: "客厅", url: `${assetBase}/背景-客厅.png` };
  }

  function findStageState(id) {
    return state.assets.states.find((item) => item.id === id)
      || state.assets.states.find((item) => item.id === state.assets.default_state)
      || { id: "平静", name: "平静", url: `${assetBase}/透明视频/平静.webm`, mime: "video/webm", kind: "transparent" };
  }

  function stageLabel(id) {
    return String(id || "").replace(/^背景-/, "");
  }

  function updateStageTitle() {
    $("dateStageName").textContent = `${stageLabel(state.currentBackground)} · ${stageLabel(state.currentState)}`;
  }

  function closeActionPicker() {
    state.actionPickerOpen = false;
    const picker = $("dateActionPicker");
    const btn = $("dateActionPickerBtn");
    if (picker) picker.hidden = true;
    if (btn) btn.classList.remove("active");
  }

  function renderActionPicker() {
    const list = $("dateActionPickerList");
    const empty = $("dateActionPickerEmpty");
    if (!list || !empty) return;
    const actions = (Array.isArray(state.assets.states) ? state.assets.states : [])
      .map((item, index) => ({ item, index, transparent: isTransparentAction(item) }))
      .sort((a, b) => Number(b.transparent) - Number(a.transparent) || a.index - b.index)
      .map(({ item, transparent }) => ({ ...item, transparent }));
    list.innerHTML = actions.map((item) => {
      const id = String(item.id || "");
      const name = item.name || id;
      const active = id === state.currentState ? " active" : "";
      const badge = item.transparent ? '<span class="action-picker-badge">透明</span>' : "";
      return `<button class="action-picker-item${active}" type="button" data-date-action="${esc(id)}" title="${esc(name)}"><span class="action-picker-name">${esc(name)}</span>${badge}</button>`;
    }).join("");
    empty.hidden = actions.length > 0;
    list.querySelectorAll("[data-date-action]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.dateAction || "";
        if (!id) return;
        if (state.session) state.session.current_state = id;
        closeActionPicker();
        await switchState(id);
        renderActionPicker();
      };
    });
  }

  function toggleActionPicker() {
    const picker = $("dateActionPicker");
    const btn = $("dateActionPickerBtn");
    if (!picker || !btn || btn.disabled) return;
    renderActionPicker();
    state.actionPickerOpen = !state.actionPickerOpen;
    picker.hidden = !state.actionPickerOpen;
    btn.classList.toggle("active", state.actionPickerOpen);
  }

  function isTransparentAction(item) {
    const url = String(item?.url || "");
    return item?.kind === "transparent" || url.includes("/透明视频/");
  }

  function switchBackground(id, instant = false) {
    const item = findBackground(id);
    state.currentBackground = item.id;
    const layers = [document.querySelector(".date-bg-a"), document.querySelector(".date-bg-b")];
    const next = layers[state.bgLayer ? 0 : 1];
    const prev = layers[state.bgLayer ? 1 : 0];
    next.style.backgroundImage = `url("${item.url}")`;
    if (instant) {
      prev.classList.remove("active");
      next.classList.add("active");
    } else {
      requestAnimationFrame(() => {
        next.classList.add("active");
        prev.classList.remove("active");
      });
    }
    state.bgLayer = state.bgLayer ? 0 : 1;
    updateStageTitle();
  }

  function fadeVolume(media, to, duration = 520) {
    const from = media.volume || 0;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      media.volume = from + (to - from) * t;
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  async function switchState(id, instant = false) {
    const item = findStageState(id);
    state.currentState = item.id;
    const videos = [$("dateActorA"), $("dateActorB")];
    const next = videos[state.actorLayer ? 0 : 1];
    const prev = videos[state.actorLayer ? 1 : 0];
    const targetVolume = state.videoSound ? state.videoVolume : 0;

    next.className = "date-actor-video";
    next.classList.add(item.kind === "scene" ? "scene-video" : "transparent-video");
    next.src = item.url;
    next.muted = !state.videoSound;
    next.volume = instant ? targetVolume : 0;
    next.loop = item.loop !== false;
    next.playsInline = true;
    try { await next.play(); } catch (e) {}

    if (instant) {
      prev.pause();
      prev.removeAttribute("src");
      prev.load();
      prev.classList.remove("active");
      next.classList.add("active");
    } else {
      fadeVolume(prev, 0, 420);
      fadeVolume(next, targetVolume, 620);
      requestAnimationFrame(() => {
        next.classList.add("active");
        prev.classList.remove("active");
      });
      window.setTimeout(() => {
        if (!prev.classList.contains("active")) {
          prev.pause();
          prev.removeAttribute("src");
          prev.load();
        }
      }, 720);
    }
    state.actorLayer = state.actorLayer ? 0 : 1;
    updateStageTitle();
    renderActionPicker();
  }

  function applyStage(stage, instant = false) {
    if (!stage) return;
    if (stage.background) switchBackground(stage.background, instant);
    if (stage.state) switchState(stage.state, instant);
  }

  function stageFromMessage(message) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const stage = attachments.find((item) => item && item.type === "date_stage");
    if (!stage) return null;
    return {
      background: stage.background || null,
      state: stage.state || null,
    };
  }

  function stripControlTags(text) {
    return String(text || "")
      .replace(/\[DATE_(?:BACKGROUND|BG|STATE|ACTION)\s*:[^\]]*\]/gi, "")
      .replace(/\[DATE_END_READY\]/gi, "")
      .replace(/\[MUSIC\s*:[^\]]*\]/gi, "")
      .trim();
  }

  function stopStatusAnimation() {
    if (state.statusAnimationTimer) {
      window.clearInterval(state.statusAnimationTimer);
      state.statusAnimationTimer = null;
    }
  }

  function setStatus(text, options = {}) {
    const el = $("dateStatus");
    stopStatusAnimation();
    if (text && options.animated) {
      let tick = 0;
      const render = () => {
        tick = (tick % 3) + 1;
        el.textContent = `${text}${".".repeat(tick)}`;
      };
      render();
      state.statusAnimationTimer = window.setInterval(render, 420);
    } else {
      el.textContent = text || "";
    }
    el.classList.toggle("active", Boolean(text));
  }

  function resetDateInputHeight() {
    const input = $("dateInput");
    if (input) input.style.height = "";
  }

  function activePersonaPreset() {
    return state.personaPresets.find(item => item.id === state.config.active_persona_id) || state.personaPresets[0] || null;
  }

  function currentPartnerName() {
    const active = activePersonaPreset();
    return String(active?.name || state.config.partner_name || state.world.ai_name || "AI").trim() || "AI";
  }

  function renderLastDialogue(message) {
    if (!message) return;
    $("dateSpeakerName").textContent = message.role === "user" ? state.world.user_name : (state.session?.partner_name || currentPartnerName());
    $("dateDialogueText").textContent = message.content || "";
  }

  function messageName(msg) {
    return msg.role === "user" ? state.world.user_name : (msg.role === "assistant" ? (state.session?.partner_name || currentPartnerName()) : "系统");
  }

  function compactCharCount(text) {
    return String(text || "").replace(/\s/g, "").length;
  }

  function estimateDateTokens(text) {
    text = String(text || "");
    if (!text.trim()) return 0;
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const other = Math.max(0, text.length - cjk);
    return Math.max(1, Math.floor(cjk * 0.75 + other / 4 + 0.5));
  }

  function currentPersonaText() {
    const active = activePersonaPreset();
    return String(
      state.session?.persona
      || $("datePersona")?.value
      || active?.persona
      || state.config.persona
      || ""
    ).trim();
  }

  function nextPromptEstimate() {
    const persona = currentPersonaText();
    const plot = state.messages
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => String(msg.content || ""))
      .filter(Boolean)
      .join("\n");
    const draft = state.session?.status === "active" ? String($("dateInput")?.value || "").trim() : "";
    const estimatedText = [persona, plot, draft].filter(Boolean).join("\n");
    return {
      personaChars: compactCharCount(persona),
      estimatedTokens: estimateDateTokens(estimatedText),
    };
  }

  function messageChars(role) {
    return state.messages
      .filter((msg) => !role || msg.role === role)
      .reduce((sum, msg) => sum + compactCharCount(msg.content), 0);
  }

  function renderLogStats() {
    const aiChars = messageChars("assistant");
    const userChars = messageChars("user");
    const total = aiChars + userChars;
    const estimate = nextPromptEstimate();
    const tokenText = estimate.estimatedTokens ? `｜人设字数：${estimate.personaChars}｜下次输入约 ${estimate.estimatedTokens} tokens` : "";
    $("dateLogStats").textContent = `剧情字数：${total}（AI ${aiChars} / 你 ${userChars}）${tokenText}`;
  }

  function canDeleteDateMessage(msg) {
    const id = String(msg?.id || "");
    return Boolean(id) && !id.startsWith("local_") && !id.startsWith("pending_");
  }

  function renderMessages() {
    const list = $("dateMessageList");
    list.innerHTML = state.messages.map((msg, index) => {
      const name = messageName(msg);
      const reviewBtn = `<button class="log-msg-review" data-review-msg-index="${index}" title="从这里开始回看" aria-label="从这里开始回看">▶</button>`;
      const deleteBtn = canDeleteDateMessage(msg)
        ? `<button class="log-msg-delete" data-delete-msg-id="${esc(msg.id)}" title="删除这条消息" aria-label="删除这条消息">&times;</button>`
        : "";
      return `<article class="log-msg">${reviewBtn}${deleteBtn}<strong>${esc(name)}</strong><p>${esc(msg.content || "")}</p></article>`;
    }).join("");
    list.querySelectorAll("[data-review-msg-index]").forEach((btn) => {
      btn.onclick = () => startDateReviewFromIndex(Number(btn.dataset.reviewMsgIndex || 0));
    });
    list.querySelectorAll("[data-delete-msg-id]").forEach((btn) => {
      btn.onclick = () => deleteDateMessage(btn.dataset.deleteMsgId);
    });
    list.scrollTop = list.scrollHeight;
    if (state.messages.length) {
      renderLastDialogue(state.messages[state.messages.length - 1]);
    } else {
      $("dateDialogueText").textContent = "今晚从客厅开始。";
    }
    renderLogStats();
  }

  async function deleteDateMessage(msgId) {
    if (!msgId || state.sending) return;
    if (state.reviewing) {
      setStatus("回看中不能删除消息");
      return;
    }
    const msg = state.messages.find(item => item.id === msgId);
    const preview = String(msg?.content || "").trim().slice(0, 24);
    const ok = window.confirm(`删除这条约会消息吗？${preview ? `\n「${preview}${String(msg?.content || "").length > 24 ? "..." : ""}」` : ""}\n删除后会回到剩余记录里的最后一条继续。`);
    if (!ok) return;
    setStatus("删除消息中");
    try {
      const data = await api("DELETE", `/api/date-theater/messages/${encodeURIComponent(msgId)}`);
      if (data.session) state.session = data.session;
      state.messages = data.messages || state.messages.filter(item => item.id !== msgId);
      state.assets = data.assets || state.assets;
      state.currentTtsUrls.delete(msgId);
      applySessionStage(true);
      renderMessages();
      renderMode();
      setStatus("");
    } catch (e) {
      setStatus(e.message || "删除消息失败");
    }
  }

  function formatDateTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function renderSessionList() {
    const list = $("dateEntryList");
    if (!list) return;
    list.innerHTML = state.sessions.map((item) => {
      const status = item.status === "ended" ? "已完成" : (item.status === "active" ? "进行中" : (item.status === "outlined" ? "已生成大纲" : "草稿"));
      const preview = item.summary || item.outline || item.prompt || "";
      const timeText = formatDateTime(item.updated_at || item.created_at);
      return `<article class="date-entry"><button class="date-entry-main" data-session-id="${esc(item.id)}"><strong>${esc(item.title || "未命名约会")}</strong><span>${status}${timeText ? ` · ${esc(timeText)}` : ""}</span>${preview ? `<p>${esc(preview)}</p>` : ""}</button><button class="date-entry-delete" data-delete-session-id="${esc(item.id)}" data-delete-title="${esc(item.title || "未命名约会")}" title="删除约会" aria-label="删除约会">×</button></article>`;
    }).join("");
    $("dateEntryEmpty").hidden = state.sessions.length > 0;
    list.querySelectorAll("[data-session-id]").forEach((btn) => {
      btn.onclick = () => loadSession(btn.dataset.sessionId);
    });
    list.querySelectorAll("[data-delete-session-id]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        deleteSession(btn.dataset.deleteSessionId, btn.dataset.deleteTitle || "未命名约会");
      };
    });
  }

  async function deleteSession(sessionId, title) {
    if (!sessionId) return;
    stopDateReview(false);
    const ok = window.confirm(`确定删除这场约会「${title || "未命名约会"}」吗？\n约会记录和本场 TTS 音频会被删除，已经同步到聊天窗口的系统消息不会删除。`);
    if (!ok) return;
    try {
      await api("DELETE", `/api/date-theater/sessions/${encodeURIComponent(sessionId)}`);
      if (state.session?.id === sessionId) {
        state.session = null;
        state.messages = [];
        state.inSessionList = true;
      }
      await refreshSessions();
      renderMode();
      setStatus("");
    } catch (e) {
      setStatus(e.message || "删除约会失败");
    }
  }

  function applySessionStage(instant = false) {
    if (!state.session) return;
    applyStage({
      background: state.session.current_background || state.assets.default_background,
      state: state.session.current_state || state.assets.default_state,
    }, instant);
  }

  function renderOutline() {
    const hasOutline = state.session && ["outlined", "active", "ended"].includes(state.session.status);
    $("dateOutlineCard").hidden = !hasOutline;
    if (!hasOutline) return;
    $("dateOutlineTitle").textContent = state.session.title || "未命名约会";
    $("dateOutlineText").textContent = state.session.outline || "";
    $("dateOutlineEnding").textContent = state.session.ending_trigger ? `结束契机：${state.session.ending_trigger}` : "";
    $("datePromptInput").value = state.session.prompt || $("datePromptInput").value;
  }

  function updateOutlineButton(status = state.session?.status || "") {
    const btn = $("dateGenerateOutlineBtn");
    btn.disabled = state.outlineGenerating;
    btn.classList.toggle("loading", state.outlineGenerating);
    btn.textContent = state.outlineGenerating ? "生成中..." : (status === "outlined" ? "重新生成" : "生成大纲");
  }

  function renderMode() {
    const status = state.session?.status || "";
    renderActionPicker();
    $("dateSessionPicker").hidden = !state.inSessionList;
    $("dateDialoguePanel").hidden = state.inSessionList;
    $("dateLogBtn").hidden = state.inSessionList;
    $("dateMusicToggleBtn").hidden = state.inSessionList;
    $("dateBackBtn").title = state.inSessionList ? "返回 Home" : "返回约会列表";
    if (state.inSessionList) {
      closeActionPicker();
      $("dateTitle").textContent = "去约会";
      $("dateStageName").textContent = "选择一场约会";
      renderSessionList();
      updateReviewButton();
      return;
    }
    $("dateLogBtn").hidden = false;
    $("dateMusicToggleBtn").hidden = false;
    const planning = !state.session || status === "draft" || status === "outlined";
    $("datePlanner").hidden = !planning;
    $("dateChatArea").hidden = planning;
    $("dateStartBtn").hidden = status !== "outlined";
    $("dateEndBtn").hidden = status !== "active";
    $("dateEndBtn").disabled = state.reviewing;
    $("dateReplayTtsBtn").disabled = state.reviewing;
    $("dateActionPickerBtn").disabled = state.reviewing;
    if (state.reviewing) closeActionPicker();
    updateOutlineButton(status);
    $("dateInput").disabled = status === "ended" || state.reviewing;
    $("dateSendBtn").disabled = status === "ended" || state.sending || state.reviewing;
    updateReviewButton();
    if (state.session?.title) $("dateTitle").textContent = state.session.title;
    if (planning) {
      $("dateSpeakerName").textContent = state.session?.partner_name || currentPartnerName();
    }
    renderOutline();
  }

  function addMessage(msg) {
    state.messages.push(msg);
    renderMessages();
  }

  function updateMessage(id, patch) {
    const msg = state.messages.find((item) => item.id === id);
    if (msg) Object.assign(msg, patch);
    renderMessages();
  }

  function attachTtsUrl(msgId, url) {
    if (!msgId || !url) return;
    state.currentTtsUrls.set(msgId, url);
    const msg = state.messages.find((item) => item.id === msgId);
    if (!msg) return;
    msg.tts_url = url;
    msg.attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (!msg.attachments.some((item) => item.type === "tts_audio")) {
      msg.attachments.push({ type: "tts_audio", url });
    }
    renderLogStats();
  }

  function currentAssistantMessage() {
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      if (state.messages[i].role === "assistant" && state.messages[i].content) return state.messages[i];
    }
    return null;
  }

  function setSending(flag) {
    state.sending = flag;
    const ended = state.session?.status === "ended";
    $("dateSendBtn").disabled = flag || ended || state.reviewing;
    $("dateInput").disabled = flag || ended || state.reviewing;
    updateReviewButton();
  }

  async function loadTTSVoices() {
    const sel = $("dateTtsVoice");
    sel.innerHTML = `<option value="">默认音色</option>`;
    try {
      const data = await api("GET", "/api/tts/voices");
      const voices = data.voices || [];
      for (const voice of voices) {
        const id = voice.uri || voice.id || voice.name || voice;
        const name = voice.name || voice.uri || voice.id || voice;
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      if (state.ttsVoice) sel.value = state.ttsVoice;
    } catch (e) {}
  }

  function normalizePreset(item, index) {
    const id = String(item?.id || item?.name || `preset_${index + 1}`).replace(/[^a-zA-Z0-9_\-]/g, "_") || `preset_${index + 1}`;
    return {
      id,
      name: String(item?.name || id).trim() || id,
      persona: String(item?.persona || "").trim(),
    };
  }

  function syncPresetsFromConfig() {
    const raw = Array.isArray(state.config.persona_presets) ? state.config.persona_presets : [];
    state.personaPresets = raw.map(normalizePreset).filter(item => item.persona);
    if (!state.personaPresets.length) {
      state.personaPresets = [{
        id: "default",
        name: String(state.config.partner_name || state.world.ai_name || "AI").trim() || "AI",
        persona: String(state.config.persona || "").trim() || "温柔、克制、会自然推进约会。",
      }];
    }
    if (!state.personaPresets.some(item => item.id === state.config.active_persona_id)) {
      state.config.active_persona_id = state.personaPresets[0].id;
    }
    const active = state.personaPresets.find(item => item.id === state.config.active_persona_id) || state.personaPresets[0];
    state.config.persona = active.persona;
    state.config.partner_name = String(active.name || state.config.partner_name || state.world.ai_name || "AI").trim() || "AI";
  }

  function renderPersonaPresets() {
    syncPresetsFromConfig();
    const sel = $("datePersonaPreset");
    sel.innerHTML = state.personaPresets.map(item => (
      `<option value="${esc(item.id)}"${item.id === state.config.active_persona_id ? " selected" : ""}>${esc(item.name)}</option>`
    )).join("");
    const active = state.personaPresets.find(item => item.id === state.config.active_persona_id) || state.personaPresets[0];
    $("datePersona").value = active?.persona || "";
  }

  function renderModelOptions(selected) {
    const sel = $("dateModel");
    const keys = [...new Set((state.models || []).map(item => item.key).filter(Boolean))];
    const current = selected && keys.includes(selected) ? selected : (keys[0] || selected || "");
    sel.innerHTML = keys.map(key => `<option value="${esc(key)}"${key === current ? " selected" : ""}>${esc(key)}</option>`).join("");
    if (!keys.length && current) {
      sel.innerHTML = `<option value="${esc(current)}">${esc(current)}</option>`;
    }
    sel.value = current;
    state.config.model = current;
  }

  function updateActivePresetFromEditor() {
    syncPresetsFromConfig();
    const activeId = $("datePersonaPreset").value || state.config.active_persona_id;
    state.config.active_persona_id = activeId;
    const active = state.personaPresets.find(item => item.id === activeId) || state.personaPresets[0];
    if (active) {
      active.persona = $("datePersona").value.trim();
      state.config.persona = active.persona;
      state.config.partner_name = String(active.name || state.config.partner_name || state.world.ai_name || "AI").trim() || "AI";
    }
    state.config.persona_presets = state.personaPresets;
  }

  function saveLocalAudioSettings() {
    localStorage.setItem("date_video_sound", state.videoSound ? "1" : "0");
    localStorage.setItem("date_video_volume", String(Math.round(state.videoVolume * 100)));
    localStorage.setItem("date_music_enabled", state.musicEnabled ? "1" : "0");
    localStorage.setItem("date_music_volume", String(Math.round(state.musicVolume * 100)));
    localStorage.setItem("date_tts_enabled", state.ttsEnabled ? "1" : "0");
    localStorage.setItem("date_tts_voice", state.ttsVoice || "");
  }

  function applyAudioControls() {
    $("dateVideoSoundToggle").checked = state.videoSound;
    $("dateVideoVolume").value = Math.round(state.videoVolume * 100);
    $("dateMusicToggle").checked = state.musicEnabled;
    $("dateMusicVolume").value = Math.round(state.musicVolume * 100);
    $("dateTtsToggle").checked = state.ttsEnabled;
    $("dateVideoMuteBtn").textContent = state.videoSound ? "♪" : "∅";
    const activeVideo = document.querySelector(".date-actor-video.active");
    if (activeVideo) {
      activeVideo.muted = !state.videoSound;
      fadeVolume(activeVideo, state.videoSound ? state.videoVolume : 0, 260);
    }
    state.musicAudio.volume = musicTargetVolume();
  }

  function silenceDateTheaterMedia() {
    state.videoSound = false;
    saveLocalAudioSettings();
    const videoToggle = $("dateVideoSoundToggle");
    if (videoToggle) videoToggle.checked = false;
    const videoButton = $("dateVideoMuteBtn");
    if (videoButton) videoButton.textContent = "∅";
    document.querySelectorAll(".date-actor-video").forEach((video) => {
      video.muted = true;
      video.volume = 0;
    });
    stopDateReview(false);
    stopCurrentTTSReplay(false);
    if (state.currentTtsAudio) {
      state.currentTtsAudio.pause();
      state.currentTtsAudio.removeAttribute("src");
      state.currentTtsAudio = null;
    }
    state.ttsQueue.clear();
    state.ttsPlaying = false;
    state.musicAudio.pause();
    state.musicAudio.volume = 0;
    state.musicDucked = false;
  }

  function musicTargetVolume() {
    if (!state.musicEnabled) return 0;
    if (state.musicDucked) return Math.min(state.musicVolume, 0.10);
    return state.musicVolume;
  }

  function setMusicDucked(flag) {
    state.musicDucked = flag;
    fadeVolume(state.musicAudio, musicTargetVolume(), 260);
  }

  function setReplayButtonActive(flag) {
    const btn = $("dateReplayTtsBtn");
    if (!btn) return;
    btn.classList.toggle("active", flag);
    btn.title = flag ? "停止重听当前内容" : "重听当前内容";
    btn.setAttribute("aria-label", btn.title);
  }

  function stopCurrentTTSReplay(restoreDucking = true) {
    const audio = state.replayTtsAudio;
    if (!audio) return false;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    try { audio.load(); } catch (e) {}
    if (state.currentTtsAudio === audio) state.currentTtsAudio = null;
    state.replayTtsAudio = null;
    setReplayButtonActive(false);
    if (restoreDucking) setMusicDucked(Boolean(state.ttsPlaying));
    return true;
  }

  function showMusic(song) {
    $("dateMusicPlayer").hidden = !state.musicExpanded;
    $("dateMusicToggleBtn").classList.add("has-media");
    $("dateMusicName").textContent = song.name || song.keyword || "点歌";
    $("dateMusicArtist").textContent = song.artist || "";
  }

  function toggleMusicPanel() {
    state.musicExpanded = !state.musicExpanded;
    $("dateMusicPlayer").hidden = !state.musicExpanded;
  }

  function closeMusic() {
    fadeVolume(state.musicAudio, 0, 260);
    window.setTimeout(() => {
      state.musicAudio.pause();
      state.musicAudio.removeAttribute("src");
      $("dateMusicPlayer").hidden = true;
      state.musicExpanded = false;
      $("dateMusicToggleBtn").classList.remove("has-media");
      $("dateMusicSeek").value = 0;
    }, 280);
  }

  async function playMusic(song) {
    if (!state.musicEnabled || !song || !song.id) return;
    showMusic(song);
    const nextSrc = `/api/music/stream/${song.id}`;
    fadeVolume(state.musicAudio, 0, 260);
    window.setTimeout(async () => {
      state.musicAudio.src = nextSrc;
      state.musicAudio.volume = 0;
      try {
        await state.musicAudio.play();
        fadeVolume(state.musicAudio, musicTargetVolume(), 540);
        $("dateMusicPlayBtn").textContent = "Ⅱ";
      } catch (e) {}
    }, 280);
  }

  function enqueueTTS(msgId, seq, url) {
    if (!state.ttsEnabled) return;
    if (!state.ttsQueue.has(msgId)) state.ttsQueue.set(msgId, []);
    const chunks = state.ttsQueue.get(msgId);
    if (!chunks.find((item) => item.seq === seq)) {
      chunks.push({ seq, url });
      chunks.sort((a, b) => a.seq - b.seq);
    }
    if (!state.ttsPlaying) playNextTTS();
  }

  function markTTSDone(msgId) {
    const chunks = state.ttsQueue.get(msgId);
    if (chunks) chunks.done = true;
    if (!state.ttsPlaying) playNextTTS();
  }

  function playNextTTS() {
    for (const [msgId, chunks] of state.ttsQueue) {
      if (chunks.played === undefined) chunks.played = 0;
      if (chunks.played < chunks.length) {
        const chunk = chunks[chunks.played++];
        state.ttsPlaying = true;
        setMusicDucked(true);
        const audio = new Audio(chunk.url);
        state.currentTtsAudio = audio;
        audio.onended = () => {
          state.currentTtsAudio = null;
          playNextTTS();
        };
        audio.onerror = () => {
          state.currentTtsAudio = null;
          playNextTTS();
        };
        audio.play().catch(() => {
          chunks.played = Math.max(0, chunks.played - 1);
          state.ttsPlaying = false;
          setMusicDucked(false);
        });
        return;
      }
      if (chunks.done && chunks.played >= chunks.length) {
        state.ttsQueue.delete(msgId);
      }
    }
    state.ttsPlaying = false;
    setMusicDucked(false);
  }

  function openModal(el) {
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }

  function closeModal(el) {
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }

  async function refreshSessions() {
    try {
      state.sessions = await api("GET", "/api/date-theater/sessions");
      renderSessionList();
    } catch (e) {
      state.sessions = [];
    }
  }

  async function loadSession(sessionId) {
    if (!sessionId) return;
    stopDateReview(false);
    try {
      const data = await api("GET", `/api/date-theater/sessions/${encodeURIComponent(sessionId)}`);
      state.session = data.session;
      state.messages = data.messages || [];
      state.assets = data.assets || state.assets;
      state.inSessionList = false;
      $("dateTitle").textContent = state.session.title || "去约会";
      $("dateSpeakerName").textContent = state.session.partner_name || currentPartnerName();
      applySessionStage(true);
      renderMessages();
      renderMode();
    } catch (e) {
      setStatus(e.message || "加载约会失败");
    }
  }

  async function showSessionList() {
    stopDateReview(false);
    state.inSessionList = true;
    $("dateLogDrawer").classList.remove("open");
    $("dateLogDrawer").setAttribute("aria-hidden", "true");
    await refreshSessions();
    renderMode();
    renderLogStats();
  }

  async function generateOutline() {
    stopDateReview(false);
    const prompt = $("datePromptInput").value.trim();
    if (!prompt) {
      setStatus("先写约会提示");
      $("datePromptInput").focus();
      return;
    }
    updateActivePresetFromEditor();
    state.outlineGenerating = true;
    updateOutlineButton(state.session?.status || "");
    setStatus("正在生成约会大纲...");
    try {
      const data = await api("POST", "/api/date-theater/sessions/outline", {
        session_id: state.session?.status === "outlined" ? state.session.id : "",
        prompt,
        partner_name: currentPartnerName(),
        persona: $("datePersona").value.trim() || state.config.persona || "",
        active_persona_id: state.config.active_persona_id || "",
        model: $("dateModel").value.trim(),
      });
      state.session = data.session;
      state.messages = data.messages || [];
      state.assets = data.assets || state.assets;
      state.inSessionList = false;
      $("dateTitle").textContent = state.session.title || "去约会";
      applySessionStage();
      renderMessages();
      await refreshSessions();
      renderMode();
      $("dateStartBtn").disabled = false;
      setStatus("");
    } catch (e) {
      setStatus(e.message || "大纲生成失败");
    } finally {
      state.outlineGenerating = false;
      updateOutlineButton(state.session?.status || "");
    }
  }

  async function startDate() {
    stopDateReview(false);
    if (!state.session || state.session.status !== "outlined") {
      setStatus("先生成大纲");
      return;
    }
    $("dateStartBtn").disabled = true;
    setStatus("开始中");
    try {
      const data = await api("POST", `/api/date-theater/sessions/${encodeURIComponent(state.session.id)}/start`, {
        model: $("dateModel").value.trim(),
      });
      state.session = data.session;
      state.messages = data.messages || [];
      state.assets = data.assets || state.assets;
      state.inSessionList = false;
      $("dateTitle").textContent = state.session.title || "去约会";
      applySessionStage();
      setStatus("");
      renderMessages();
      await refreshSessions();
      renderMode();
      $("dateStartBtn").disabled = false;
    } catch (e) {
      setStatus(e.message || "开场失败");
      $("dateStartBtn").disabled = false;
    }
  }

  async function sendMessage(text) {
    if (!state.session || state.session.status !== "active" || state.sending || state.reviewing) return;
    setSending(true);
    const userMsg = {
      id: `local_${Date.now()}`,
      session_id: state.session.id,
      role: "user",
      content: text,
      created_at: Date.now() / 1000,
      attachments: [],
    };
    addMessage(userMsg);
    setStatus("正在编写约会剧情", { animated: true });

    const aiMsgId = `pending_${Date.now()}`;
    addMessage({
      id: aiMsgId,
      session_id: state.session.id,
      role: "assistant",
      content: "",
      created_at: Date.now() / 1000,
      attachments: [],
    });

    try {
      const res = await fetch(`/api/date-theater/sessions/${encodeURIComponent(state.session.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          model: $("dateModel").value.trim(),
          tts_enabled: state.ttsEnabled,
          tts_voice: state.ttsVoice,
        }),
      });
      if (!res.ok || !res.body) throw new Error("发送失败");
      await readEventStream(res.body, aiMsgId);
    } catch (e) {
      updateMessage(aiMsgId, { content: e.message || "发送失败" });
      setStatus("发送失败");
    } finally {
      setSending(false);
      $("dateInput").focus();
    }
  }

  async function readEventStream(body, aiMsgId) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let content = "";
    let realId = aiMsgId;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (e) {
          continue;
        }
        if (event.type === "start" && event.id) {
          realId = event.id;
          updateMessage(aiMsgId, { id: realId });
        } else if (event.type === "chunk") {
          content += event.content || "";
          updateMessage(realId, { content: stripControlTags(content) });
        } else if (event.type === "message_final") {
          updateMessage(realId, event.data);
          if (event.data?.stage) {
            applyStage(event.data.stage);
            if (event.data.stage.background) state.session.current_background = event.data.stage.background;
            if (event.data.stage.state) state.session.current_state = event.data.stage.state;
          }
          if (event.data?.music?.length) playMusic(event.data.music[0]);
          setStatus("");
        } else if (event.type === "tts_chunk" && event.data) {
          enqueueTTS(event.data.msg_id, event.data.seq, event.data.url);
        } else if (event.type === "tts_done" && event.data) {
          markTTSDone(event.data.msg_id);
        } else if (event.type === "tts_merged" && event.data) {
          attachTtsUrl(event.data.msg_id, event.data.url);
        }
      }
    }
  }

  async function replayCurrentTTS() {
    if (state.reviewing) return;
    if (state.replayTtsAudio && !state.replayTtsAudio.ended) {
      stopCurrentTTSReplay();
      return;
    }
    stopCurrentTTSReplay(false);
    const msg = currentAssistantMessage();
    if (!msg) return;
    const known = msg.tts_url || state.currentTtsUrls.get(msg.id);
    const url = known || `/api/date-theater/tts/audio/${encodeURIComponent(msg.id)}`;
    try {
      const probe = known ? { ok: true } : await fetch(url, { method: "HEAD" });
      if (!probe.ok) {
        setStatus("当前内容还没有可重听的 TTS");
        return;
      }
      setMusicDucked(true);
      const audio = new Audio(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
      state.replayTtsAudio = audio;
      state.currentTtsAudio = audio;
      audio.onended = () => {
        if (state.replayTtsAudio === audio) state.replayTtsAudio = null;
        if (state.currentTtsAudio === audio) state.currentTtsAudio = null;
        setReplayButtonActive(false);
        setMusicDucked(Boolean(state.ttsPlaying));
      };
      audio.onerror = () => {
        if (state.replayTtsAudio === audio) state.replayTtsAudio = null;
        if (state.currentTtsAudio === audio) state.currentTtsAudio = null;
        setReplayButtonActive(false);
        setMusicDucked(Boolean(state.ttsPlaying));
      };
      setReplayButtonActive(true);
      await audio.play();
    } catch (e) {
      stopCurrentTTSReplay(false);
      setMusicDucked(false);
      setStatus("重听失败");
    }
  }

  function updateReviewButton() {
    const btn = $("dateReviewBtn");
    if (!btn) return;
    const status = state.session?.status || "";
    const planning = !state.session || status === "draft" || status === "outlined";
    btn.hidden = state.inSessionList || planning || !state.messages.length;
    btn.disabled = !state.reviewing && (state.sending || !state.messages.length);
    btn.classList.toggle("active", state.reviewing);
    btn.textContent = state.reviewing ? "■" : "▶";
    btn.title = state.reviewing ? "停止回看" : "回看约会";
    btn.setAttribute("aria-label", btn.title);
  }

  function cacheBust(url) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  }

  function clearReviewTimer() {
    if (state.reviewTimer) {
      window.clearTimeout(state.reviewTimer);
      state.reviewTimer = null;
    }
    if (state.reviewTimerResolve) {
      const resolve = state.reviewTimerResolve;
      state.reviewTimerResolve = null;
      resolve();
    }
  }

  function clearReviewAudio() {
    if (state.reviewAudio) {
      state.reviewAudio.pause();
      state.reviewAudio.removeAttribute("src");
      state.reviewAudio = null;
    }
    if (state.reviewAudioResolve) {
      const resolve = state.reviewAudioResolve;
      state.reviewAudioResolve = null;
      resolve();
    }
  }

  function stopDateReview(showStatus = true) {
    if (!state.reviewing && !state.reviewTimer && !state.reviewAudio) return;
    state.reviewing = false;
    clearReviewTimer();
    clearReviewAudio();
    setMusicDucked(false);
    updateReviewButton();
    renderMode();
    if (showStatus) setStatus("回看已停止");
  }

  function reviewDelay(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        state.reviewTimer = null;
        state.reviewTimerResolve = null;
        resolve();
      };
      state.reviewTimerResolve = done;
      state.reviewTimer = window.setTimeout(done, ms);
    });
  }

  function playReviewAudioUrl(url) {
    return new Promise((resolve) => {
      if (!state.reviewing || !url) {
        resolve();
        return;
      }
      const audio = new Audio(cacheBust(url));
      state.reviewAudio = audio;
      const done = () => {
        audio.onended = null;
        audio.onerror = null;
        if (state.reviewAudio === audio) state.reviewAudio = null;
        state.reviewAudioResolve = null;
        resolve();
      };
      state.reviewAudioResolve = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }

  async function messageTtsUrls(message) {
    if (!message?.id) return [];
    try {
      const data = await api("GET", `/api/date-theater/messages/${encodeURIComponent(message.id)}/tts`);
      if (Array.isArray(data.urls) && data.urls.length) return data.urls;
    } catch (e) {}
    const directUrl = `/api/date-theater/tts/audio/${encodeURIComponent(message.id)}`;
    try {
      const probe = await fetch(directUrl, { method: "HEAD" });
      if (probe.ok) return [directUrl];
    } catch (e) {}
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return attachments
      .filter((item) => item && item.type === "tts_audio" && item.url)
      .map((item) => item.url);
  }

  async function startDateReviewFromIndex(startIndex = 0) {
    if (state.reviewing) {
      stopDateReview();
      return;
    }
    if (state.sending) {
      setStatus("等当前回复完成后再回看");
      return;
    }
    if (!state.messages.length) {
      setStatus("还没有可以回看的约会记录");
      return;
    }

    const safeStart = Math.max(0, Math.min(Number(startIndex) || 0, state.messages.length - 1));
    stopCurrentTTSReplay(false);
    if (state.currentTtsAudio) {
      state.currentTtsAudio.pause();
      state.currentTtsAudio.removeAttribute("src");
      state.currentTtsAudio = null;
    }
    state.ttsQueue.clear();
    state.ttsPlaying = false;
    setMusicDucked(false);

    const snapshot = state.messages.slice(safeStart);
    state.reviewing = true;
    $("dateLogDrawer").classList.remove("open");
    $("dateLogDrawer").setAttribute("aria-hidden", "true");
    updateReviewButton();
    renderMode();

    let completed = false;
    try {
      for (let i = 0; i < snapshot.length; i += 1) {
        if (!state.reviewing) break;
        const msg = snapshot[i];
        renderLastDialogue(msg);
        applyStage(stageFromMessage(msg));
        $("dateDialogueText").scrollTop = 0;
        setStatus(`回看中 ${safeStart + i + 1}/${state.messages.length}`);

        const urls = await messageTtsUrls(msg);
        if (!state.reviewing) break;
        if (urls.length) {
          setMusicDucked(true);
          for (const url of urls) {
            if (!state.reviewing) break;
            await playReviewAudioUrl(url);
          }
          setMusicDucked(false);
        } else {
          const fallbackDelay = msg.role === "user" ? 3000 : 10000;
          await reviewDelay(fallbackDelay);
        }
      }
      completed = state.reviewing;
      if (completed) setStatus("回看完成");
    } catch (e) {
      setStatus(e.message || "回看失败");
    } finally {
      state.reviewing = false;
      clearReviewTimer();
      clearReviewAudio();
      setMusicDucked(false);
      updateReviewButton();
      renderMode();
      if (completed) {
        window.setTimeout(() => {
          if (!state.reviewing && $("dateStatus").textContent === "回看完成") setStatus("");
        }, 1600);
      }
    }
  }

  async function startDateReview() {
    return startDateReviewFromIndex(0);
  }

  function newDateDraft() {
    stopDateReview(false);
    state.inSessionList = false;
    state.session = null;
    state.messages = [];
    $("datePromptInput").value = "";
    $("dateTitle").textContent = "去约会";
    $("dateDialogueText").textContent = "今晚从客厅开始。";
    switchBackground(state.assets.default_background || "背景-客厅", true);
    switchState(state.assets.default_state || "平静", true);
    closeModal($("dateEndConfirmModal"));
    closeModal($("dateEndModal"));
    renderMessages();
    renderMode();
  }

  function requestEndDate() {
    if (!state.session || state.session.status !== "active") return;
    stopDateReview(false);
    openModal($("dateEndConfirmModal"));
  }

  async function endDate() {
    if (!state.session) return;
    closeModal($("dateEndConfirmModal"));
    $("dateEndConfirmBtn").disabled = true;
    setStatus("收束中");
    try {
      const data = await api("POST", `/api/date-theater/sessions/${encodeURIComponent(state.session.id)}/end`);
      state.session = data.session;
      $("dateTitle").textContent = state.session.title || "去约会";
      $("dateEndTitle").textContent = state.session.title || "约会结束";
      $("dateEndSummary").textContent = state.session.summary || "";
      setStatus("");
      await refreshSessions();
      renderMode();
      await refreshSyncTarget();
      openModal($("dateEndModal"));
    } catch (e) {
      setStatus(e.message || "结束失败");
    } finally {
      $("dateEndConfirmBtn").disabled = false;
    }
  }

  async function refreshSyncTarget() {
    const sel = $("dateSyncTargetSelect");
    try {
      const data = await api("GET", "/api/date-theater/sync-targets");
      state.syncTargets = data.targets || [];
      sel.innerHTML = state.syncTargets.map((target) => {
        const value = `${target.type || "private"}:${target.id || ""}`;
        const suffix = target.is_default ? "（最近）" : "";
        return `<option value="${esc(value)}">${esc((target.label || "同步对象") + suffix)}</option>`;
      }).join("");
      const defaultTarget = data.default_target || state.syncTargets.find(item => item.is_default) || state.syncTargets[0];
      if (defaultTarget) sel.value = `${defaultTarget.type || "private"}:${defaultTarget.id || ""}`;
      $("dateSyncBtn").disabled = Boolean(state.session?.synced_at) || !state.syncTargets.length;
      $("dateSyncTarget").textContent = state.session?.synced_at ? "已同步" : "选择同步对象后，会发送一条系统消息。";
    } catch (e) {
      state.syncTargets = [];
      sel.innerHTML = "";
      $("dateSyncBtn").disabled = true;
      $("dateSyncTarget").textContent = "同步目标加载失败";
    }
  }

  async function syncDate() {
    if (!state.session) return;
    $("dateSyncBtn").disabled = true;
    try {
      const [targetType, ...targetIdParts] = ($("dateSyncTargetSelect").value || "private:").split(":");
      const data = await api("POST", `/api/date-theater/sessions/${encodeURIComponent(state.session.id)}/sync`, {
        target_type: targetType || "private",
        target_id: targetIdParts.join(":"),
      });
      if (!data.already_synced) state.session.synced_at = Date.now() / 1000;
      $("dateSyncTarget").textContent = data.already_synced ? "已同步" : `已同步到：${data.target?.label || "同步对象"}`;
    } catch (e) {
      $("dateSyncTarget").textContent = e.message || "同步失败";
      $("dateSyncBtn").disabled = false;
    }
  }

  async function saveSettings() {
    updateActivePresetFromEditor();
    state.config.partner_name = currentPartnerName();
    state.config.model = $("dateModel").value.trim();
    state.config.model_locked = Boolean(state.config.model && state.config.model !== state.chatroomModel);
    state.config.persona = $("datePersona").value.trim();
    state.config.persona_presets = state.personaPresets;
    state.ttsEnabled = $("dateTtsToggle").checked;
    state.ttsVoice = $("dateTtsVoice").value;
    state.musicEnabled = $("dateMusicToggle").checked;
    state.musicVolume = Number($("dateMusicVolume").value) / 100;
    state.videoSound = $("dateVideoSoundToggle").checked;
    state.videoVolume = Number($("dateVideoVolume").value) / 100;
    saveLocalAudioSettings();
    applyAudioControls();
    try {
      const data = await api("PUT", "/api/date-theater/config", state.config);
      state.config = data.config || state.config;
      if (Array.isArray(data.models)) state.models = data.models;
      state.chatroomModel = data.chatroom_model || state.chatroomModel;
      renderModelOptions(state.config.model);
      renderPersonaPresets();
      $("dateSpeakerName").textContent = currentPartnerName();
      closeModal($("dateSettingsModal"));
    } catch (e) {
      setStatus(e.message || "保存失败");
    }
  }

  function goHome() {
    silenceDateTheaterMedia();
    try {
      if (window.parent && window.parent !== window && typeof window.parent.navigateToHome === "function") {
        window.parent.navigateToHome();
        return;
      }
    } catch (e) {}
    window.location.href = "/";
  }

  function bindEvents() {
    $("dateBackBtn").onclick = () => {
      if (state.inSessionList) {
        goHome();
      } else {
        showSessionList();
      }
    };
    $("dateCreateNewBtn").onclick = newDateDraft;
    $("dateGenerateOutlineBtn").onclick = generateOutline;
    $("dateStartBtn").onclick = startDate;
    $("dateSettingsBtn").onclick = () => openModal($("dateSettingsModal"));
    $("dateSettingsCloseBtn").onclick = () => closeModal($("dateSettingsModal"));
    $("dateSaveSettingsBtn").onclick = saveSettings;
    $("datePersonaPreset").onchange = () => {
      syncPresetsFromConfig();
      state.config.active_persona_id = $("datePersonaPreset").value;
      const active = state.personaPresets.find(item => item.id === state.config.active_persona_id) || state.personaPresets[0];
      $("datePersona").value = active?.persona || "";
      state.config.partner_name = currentPartnerName();
      $("dateSpeakerName").textContent = currentPartnerName();
      renderLogStats();
    };
    $("datePersona").addEventListener("input", renderLogStats);
    $("datePresetNewBtn").onclick = () => {
      syncPresetsFromConfig();
      const name = window.prompt("新预设名称", "新的约会人设");
      if (!name) return;
      const id = `preset_${Date.now()}`;
      state.personaPresets.push({ id, name: name.trim() || "新的约会人设", persona: $("datePersona").value.trim() });
      state.config.active_persona_id = id;
      state.config.persona_presets = state.personaPresets;
      renderPersonaPresets();
      $("dateSpeakerName").textContent = currentPartnerName();
    };
    $("datePresetSaveBtn").onclick = () => {
      updateActivePresetFromEditor();
      renderPersonaPresets();
      setStatus("人设已暂存");
    };
    $("datePresetDeleteBtn").onclick = () => {
      syncPresetsFromConfig();
      if (state.personaPresets.length <= 1) {
        setStatus("至少保留一套人设");
        return;
      }
      const activeId = $("datePersonaPreset").value;
      state.personaPresets = state.personaPresets.filter(item => item.id !== activeId);
      state.config.active_persona_id = state.personaPresets[0].id;
      state.config.persona_presets = state.personaPresets;
      renderPersonaPresets();
      $("dateSpeakerName").textContent = currentPartnerName();
    };
    $("dateLogBtn").onclick = () => {
      $("dateLogDrawer").classList.add("open");
      $("dateLogDrawer").setAttribute("aria-hidden", "false");
    };
    $("dateLogCloseBtn").onclick = () => {
      $("dateLogDrawer").classList.remove("open");
      $("dateLogDrawer").setAttribute("aria-hidden", "true");
    };
    $("dateVideoMuteBtn").onclick = () => {
      state.videoSound = !state.videoSound;
      saveLocalAudioSettings();
      applyAudioControls();
    };
    $("dateMusicToggleBtn").onclick = toggleMusicPanel;
    $("dateActionPickerBtn").onclick = (e) => {
      e.stopPropagation();
      toggleActionPicker();
    };
    $("dateActionPicker").onclick = (e) => e.stopPropagation();
    $("datePanelSizeBtn").onclick = () => {
      $("dateDialoguePanel").classList.toggle("expanded");
    };
    $("dateReplayTtsBtn").onclick = replayCurrentTTS;
    const dateReviewBtn = $("dateReviewBtn");
    if (dateReviewBtn) dateReviewBtn.onclick = startDateReview;
    $("dateEndBtn").onclick = requestEndDate;
    $("dateEndCancelBtn").onclick = () => closeModal($("dateEndConfirmModal"));
    $("dateEndKeepBtn").onclick = () => closeModal($("dateEndConfirmModal"));
    $("dateEndConfirmBtn").onclick = endDate;
    $("dateEndCloseBtn").onclick = () => closeModal($("dateEndModal"));
    $("dateSyncBtn").onclick = syncDate;
    $("dateNewBtn").onclick = newDateDraft;
    $("dateMusicCloseBtn").onclick = closeMusic;
    $("dateMusicPlayBtn").onclick = () => {
      if (state.musicAudio.paused) {
        state.musicAudio.play().catch(() => {});
      } else {
        state.musicAudio.pause();
      }
    };
    $("dateMusicVolume").oninput = () => {
      state.musicVolume = Number($("dateMusicVolume").value) / 100;
      saveLocalAudioSettings();
      fadeVolume(state.musicAudio, musicTargetVolume(), 120);
    };
    $("dateVideoVolume").oninput = () => {
      state.videoVolume = Number($("dateVideoVolume").value) / 100;
      saveLocalAudioSettings();
      applyAudioControls();
    };
    $("dateForm").onsubmit = (e) => {
      e.preventDefault();
      const text = $("dateInput").value.trim();
      if (!text) return;
      $("dateInput").value = "";
      resetDateInputHeight();
      sendMessage(text);
    };
    $("dateInput").addEventListener("input", () => {
      $("dateInput").style.height = "auto";
      $("dateInput").style.height = Math.min(108, $("dateInput").scrollHeight) + "px";
      renderLogStats();
    });
    state.musicAudio.addEventListener("play", () => $("dateMusicPlayBtn").textContent = "Ⅱ");
    state.musicAudio.addEventListener("pause", () => $("dateMusicPlayBtn").textContent = "▶");
    state.musicAudio.addEventListener("timeupdate", () => {
      if (state.musicAudio.duration) {
        $("dateMusicSeek").value = Math.round((state.musicAudio.currentTime / state.musicAudio.duration) * 1000);
      }
    });
    $("dateMusicSeek").oninput = () => {
    if (state.musicAudio.duration) {
      state.musicAudio.currentTime = (Number($("dateMusicSeek").value) / 1000) * state.musicAudio.duration;
    }
  };
  state.musicAudio.addEventListener("ended", closeMusic);
  document.addEventListener("click", closeActionPicker);
  }

  async function init() {
    bindEvents();
    switchBackground("背景-客厅", true);
    await switchState("平静", true);
    try {
      const data = await api("GET", "/api/date-theater/config");
      state.config = data.config || {};
      state.world = data.world || state.world;
      state.assets = data.assets || state.assets;
      state.models = Array.isArray(data.models) ? data.models : [];
      state.chatroomModel = data.chatroom_model || "";
      renderModelOptions(state.config.model || data.chatroom_model || "");
      renderPersonaPresets();
      $("dateSpeakerName").textContent = currentPartnerName();
      switchBackground(state.assets.default_background || "背景-客厅", true);
      await switchState(state.assets.default_state || "平静", true);
      await showSessionList();
    } catch (e) {
      setStatus("素材加载失败");
    }
    await loadTTSVoices();
    applyAudioControls();
    renderMode();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
