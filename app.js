/* 校园通 · 纯原生 JS，无构建、无依赖 */
(function () {
  'use strict';

  var WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  var tips = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  var el = {
    tabs: document.querySelectorAll('.tab'),
    panels: {
      schedule: document.getElementById('panel-schedule'),
      notices: document.getElementById('panel-notices')
    },
    grid: document.getElementById('schedule-grid'),
    gridScroll: document.getElementById('grid-scroll'),
    toolbar: document.querySelector('#panel-schedule .toolbar'),
    hint: document.getElementById('schedule-hint'),
    weekSelect: document.getElementById('week-select'),
    noticeList: document.getElementById('notice-list'),
    noticeMore: document.getElementById('notice-more'),
    scheduleStamp: document.getElementById('schedule-stamp'),
    noticesStamp: document.getElementById('notices-stamp'),
    toast: document.getElementById('toast')
  };

  var state = { courses: [], week: 'all', weekOptions: [], notices: [], noticeShown: 0 };

  /* ---------------- 工具 ---------------- */

  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return '更新于 ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fetchJSON(path) {
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    var opts = { cache: 'no-store', headers: { Accept: 'application/json' } };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(path, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* "1-16周" / "1-8,10-16" / "1,3,5" → {min,max,set} */
  function parseWeeks(str) {
    var set = {};
    var min = Infinity, max = 0;
    String(str || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .split(/[,，、;；\s]+/).forEach(function (part) {
        var m = part.match(/(\d+)\s*[-~－至]\s*(\d+)/);
        if (m) {
          var a = +m[1], b = +m[2];
          if (a > b) { var t = a; a = b; b = t; }
          for (var i = a; i <= b && i - a < 30; i++) { set[i] = 1; if (i < min) min = i; if (i > max) max = i; }
          return;
        }
        var single = part.match(/\d+/);
        if (single) {
          var n = +single[0];
          set[n] = 1;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      });
    return { set: set, min: isFinite(min) ? min : 0, max: max, empty: max === 0 };
  }

  function paletteIndex(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
    return h % 6;
  }

  /* ---------------- 状态块 ---------------- */

  function showState(panel, opts) {
    var old = panel.querySelector('.state');
    if (old) old.remove();
    var box = document.createElement('div');
    box.className = 'state' + (opts.error ? ' error' : '');

    var strong = document.createElement('strong');
    strong.textContent = opts.title;
    box.appendChild(strong);

    if (opts.text) {
      var p = document.createElement('div');
      p.textContent = opts.text;
      box.appendChild(p);
    }

    if (opts.retry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试';
      btn.addEventListener('click', opts.retry);
      box.appendChild(btn);
    }

    var anchor = panel.querySelector('.toolbar') || panel.firstElementChild;
    if (anchor && anchor.nextSibling) panel.insertBefore(box, anchor.nextSibling);
    else panel.appendChild(box);
    return box;
  }

  function clearState(panel) {
    var old = panel.querySelector('.state');
    if (old) old.remove();
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  /* ---------------- 课表 ---------------- */

  function renderSchedule() {
    var grid = el.grid;
    grid.textContent = '';

    var list = state.courses;
    if (!list.length) {
      grid.style.display = 'none';
      el.hint.hidden = true;
      el.toolbar.hidden = true;
      showState(el.panels.schedule, {
        title: '还没有课表数据',
        text: '定时任务跑通后会自动出现。也可以点下面的按钮重新加载。',
        retry: loadAll
      });
      return;
    }
    clearState(el.panels.schedule);
    grid.style.display = 'grid';
    el.toolbar.hidden = false;

    var filtered = list.filter(function (c) {
      if (state.week === 'all') return true;
      var w = parseWeeks(c.weeks);
      if (w.empty) return true;
      return !!w.set[state.week];
    });

    var maxSec = 10;
    list.forEach(function (c) { if (c.end_section > maxSec) maxSec = c.end_section; });
    maxSec = Math.min(maxSec, 16);

    grid.style.gridTemplateRows = '34px repeat(' + maxSec + ', 42px)';

    // 表头
    var corner = document.createElement('div');
    corner.className = 'corner';
    corner.textContent = '节';
    grid.appendChild(corner);

    var today = new Date().getDay(); // 0=周日
    var todayCol = today === 0 ? 7 : today;
    for (var d = 1; d <= 7; d++) {
      var head = document.createElement('div');
      head.className = 'day-head' + (d === todayCol ? ' is-today' : '');
      head.textContent = WEEKDAYS[d - 1];
      grid.appendChild(head);
    }

    // 网格底纹
    for (var s = 1; s <= maxSec; s++) {
      var no = document.createElement('div');
      no.className = 'sec-no';
      no.textContent = s;
      no.style.gridColumn = '1';
      no.style.gridRow = String(s + 1);
      grid.appendChild(no);
      for (var c2 = 1; c2 <= 7; c2++) {
        var line = document.createElement('div');
        line.className = 'cell-line';
        line.style.gridColumn = String(c2 + 1);
        line.style.gridRow = String(s + 1);
        grid.appendChild(line);
      }
    }

    // 同一时段可能有多门课（比如通识课撞课），按时间片分组后纵向堆叠，避免文字互相压住
    var stacks = {};
    filtered.forEach(function (c) {
      var start = Math.max(1, Math.min(c.start_section || 1, maxSec));
      var end = Math.max(start, Math.min(c.end_section || start, maxSec));
      var key = (c.weekday || 1) + '-' + start + '-' + end;
      if (!stacks[key]) stacks[key] = { weekday: c.weekday || 1, start: start, end: end, items: [] };
      stacks[key].items.push(c);
    });

    Object.keys(stacks).forEach(function (key) {
      var s = stacks[key];
      var stack = document.createElement('div');
      stack.className = 'course-stack' + (s.items.length > 1 ? ' is-multi' : '');
      stack.style.gridColumn = String((s.weekday || 1) + 1);
      stack.style.gridRow = (s.start + 1) + ' / span ' + (s.end - s.start + 1);

      s.items.forEach(function (c) {
        var block = document.createElement('div');
        block.className = 'course theme-' + paletteIndex(c.course_name || 'x');

        var name = document.createElement('div');
        name.className = 'c-name';
        name.textContent = c.course_name || '未命名课程';
        block.appendChild(name);

        if (c.location) {
          var loc = document.createElement('div');
          loc.className = 'c-meta';
          loc.textContent = '@' + c.location;
          block.appendChild(loc);
        }

        block.addEventListener('click', function () {
          var parts = [c.course_name];
          if (c.teacher) parts.push('教师：' + c.teacher);
          if (c.location) parts.push('地点：' + c.location);
          parts.push('时间：' + tips[(c.weekday || 1) - 1] + ' 第' + s.start + '-' + s.end + '节');
          if (c.weeks) parts.push('周次：' + c.weeks);
          toast(parts.join('\n').replace(/\n/g, ' · '));
        });

        stack.appendChild(block);
      });

      grid.appendChild(stack);
    });

    // 窄屏（手机）时把「今天」那一列滚进可视区
    if (el.gridScroll.clientWidth < el.grid.scrollWidth) {
      var todayHead = grid.querySelector('.day-head.is-today');
      if (todayHead) el.gridScroll.scrollLeft = Math.max(0, todayHead.offsetLeft - 44);
    }

    var shown = filtered.length;
    el.hint.hidden = false;
    el.hint.textContent = state.week === 'all'
      ? '共 ' + list.length + ' 个上课时段，左右滑动查看整周'
      : '第 ' + state.week + ' 周共 ' + shown + ' 个上课时段';
  }

  function buildWeekOptions(courses) {
    var max = 0;
    courses.forEach(function (c) {
      var w = parseWeeks(c.weeks);
      if (w.max > max) max = w.max;
    });
    el.weekSelect.textContent = '';
    var optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '全部';
    el.weekSelect.appendChild(optAll);

    for (var i = 1; i <= Math.min(max, 30); i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = '第 ' + i + ' 周';
      el.weekSelect.appendChild(o);
    }
    el.weekSelect.value = state.week;
  }

  /* ---------------- 公告 ---------------- */

  function renderNotices(items) {
    var list = el.noticeList;
    list.textContent = '';
    state.notices = items;
    state.noticeShown = 0;

    if (!items.length) {
      el.noticeMore.hidden = true;
      showState(el.panels.notices, {
        title: '还没有公告数据',
        text: '抓取任务成功后会出现在这里。',
        retry: loadAll
      });
      return;
    }
    clearState(el.panels.notices);
    appendNoticeChunk();
  }

  function noticeItem(n) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = n.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    var t = document.createElement('div');
    t.className = 'notice-title';
    t.textContent = n.title || '(无标题)';
    a.appendChild(t);

    var meta = document.createElement('div');
    meta.className = 'notice-meta';
    if (n.department) {
      var dep = document.createElement('span');
      dep.className = 'dept';
      dep.textContent = n.department;
      meta.appendChild(dep);
    }
    if (n.date) {
      var dt = document.createElement('span');
      dt.textContent = n.date;
      meta.appendChild(dt);
    }
    a.appendChild(meta);
    li.appendChild(a);
    return li;
  }

  /* 历史累积后可能有几百条，先渲染 40 条，避免手机上一次性铺满 DOM */
  function appendNoticeChunk() {
    var CHUNK = 40;
    var slice = state.notices.slice(state.noticeShown, state.noticeShown + CHUNK);
    var frag = document.createDocumentFragment();
    slice.forEach(function (n) { frag.appendChild(noticeItem(n)); });
    el.noticeList.appendChild(frag);
    state.noticeShown += slice.length;

    var left = state.notices.length - state.noticeShown;
    if (left > 0) {
      el.noticeMore.hidden = false;
      el.noticeMore.textContent = '显示更多（还有 ' + left + ' 条）';
    } else {
      el.noticeMore.hidden = true;
    }
  }

  /* ---------------- 加载 ---------------- */

  function loadAll() {
    el.scheduleStamp.textContent = '';
    el.noticesStamp.textContent = '';

    fetchJSON('data/schedule.json').then(function (data) {
      state.courses = Array.isArray(data.courses) ? data.courses : [];
      buildWeekOptions(state.courses);
      renderSchedule();
      el.scheduleStamp.textContent = fmtStamp(data.updated_at);
    }).catch(function (err) {
      el.grid.style.display = 'none';
      el.toolbar.hidden = true;
      showState(el.panels.schedule, {
        title: '课表加载失败',
        text: '可能是网络不通，或数据还没生成（' + err.message + '）',
        retry: loadAll,
        error: true
      });
    });

    fetchJSON('data/notices.json').then(function (data) {
      var items = Array.isArray(data.notices) ? data.notices : [];
      renderNotices(items);
      el.noticesStamp.textContent = fmtStamp(data.updated_at);
    }).catch(function (err) {
      showState(el.panels.notices, {
        title: '公告加载失败',
        text: '可能是网络不通，或数据还没生成（' + err.message + '）',
        retry: loadAll,
        error: true
      });
    });
  }

  /* ---------------- 交互 ---------------- */

  el.tabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.dataset.tab;
      el.tabs.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      Object.keys(el.panels).forEach(function (k) {
        el.panels[k].classList.toggle('is-active', k === name);
      });
      if (name === 'schedule' && el.gridScroll) el.gridScroll.scrollLeft = 0;
    });
  });

  el.noticeMore.addEventListener('click', appendNoticeChunk);

  el.weekSelect.addEventListener('change', function () {
    state.week = el.weekSelect.value === 'all' ? 'all' : parseInt(el.weekSelect.value, 10);
    renderSchedule();
  });

  // 从后台切回时刷新，避免看到过期数据
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.courses.length === 0) loadAll();
  });

  loadAll();
})();
