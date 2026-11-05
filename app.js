/* 校园通 · 纯原生 JS，无构建、无依赖 */
(function () {
  'use strict';

  var WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 节次展示顺序：15 节（18:00）排在 10 节之后、11 节之前
  var SECTION_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 11, 12, 13, 14];

  var el = {
    grid: document.getElementById('schedule-grid'),
    gridScroll: document.getElementById('grid-scroll'),
    weekLabel: document.getElementById('week-label'),
    termLabel: document.getElementById('term-label'),
    prevWeek: document.getElementById('prev-week'),
    nextWeek: document.getElementById('next-week'),
    thisWeek: document.getElementById('this-week'),
    refresh: document.getElementById('refresh'),
    stamp: document.getElementById('schedule-stamp'),
    toast: document.getElementById('toast')
  };

  var state = {
    courses: [],
    sections: [],
    term: '',
    termStart: null,
    week: 0,
    maxWeek: 18,
    busy: false
  };

  /* ---------------- 工具 ---------------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return '更新于 ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function agoText(iso) {
    if (!iso) return '';
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return '刚刚';
    var m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  function checkStamp() {
    var d = new Date();
    return '检查于 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function fetchJSON(path) {
    var bust = (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    return fetch(path + bust, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  /* "1-16周" / "2-3,5-6,9-18" / "1,3,5" → {min,max,set} */
  function parseWeeks(str) {
    var set = {}, min = Infinity, max = 0;
    String(str || '').split(/[,，、;；\s]+/).forEach(function (part) {
      var m = part.match(/(\d+)\s*[-~－至]\s*(\d+)/);
      if (m) {
        var a = +m[1], b = +m[2];
        if (a > b) { var t = a; a = b; b = t; }
        for (var i = a; i <= b && i - a < 40; i++) { set[i] = 1; if (i < min) min = i; if (i > max) max = i; }
        return;
      }
      var one = part.match(/\d+/);
      if (one) {
        var n = +one[0];
        set[n] = 1; if (n < min) min = n; if (n > max) max = n;
      }
    });
    return { set: set, min: isFinite(min) ? min : 0, max: max, empty: max === 0 };
  }

  function paletteIndex(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 1009;
    return h % 7;
  }

  function shortLoc(loc) {
    var parts = String(loc || '').replace(/[【】]/g, '').trim().split(/\s+/);
    var s = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || '');
    // 在「数字/字母」与「汉字」交界处留一个可断行的位置，避免把 C-5-558机房 拆成 房/机
    return s.replace(/([0-9A-Za-z\-])([\u4e00-\u9fa5])/g, '$1\u200b$2');
  }

  function currentWeek() {
    if (!state.termStart) return 1;
    var today = startOfDay(new Date());
    var diff = Math.floor((today - startOfDay(state.termStart)) / 86400000);
    if (diff < 0) return 1;
    return Math.min(Math.floor(diff / 7) + 1, state.maxWeek);
  }

  function mondayOfWeek(week) {
    if (!state.termStart) return null;
    return addDays(startOfDay(state.termStart), (week - 1) * 7);
  }

  /* ---------------- 状态块 ---------------- */

  function showState(opts) {
    var old = document.querySelector('.viewport .state');
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
      btn.addEventListener('click', function () { loadAll(); });
      box.appendChild(btn);
    }

    var anchor = document.querySelector('.viewport .stamp-row');
    if (anchor) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    else document.querySelector('.viewport').appendChild(box);
    return box;
  }

  function clearState() {
    var old = document.querySelector('.viewport .state');
    if (old) old.remove();
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  /* ---------------- 课表 ---------------- */

  /* 教务系统只给「第1 2节 08:30-09:55」这种整段区间，
     这里按节数均分出每一节自己的上下课时间，保证左栏每行都有完整起止。 */
  function toMin(hhmm) {
    var m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  function fromMin(v) {
    v = Math.max(0, Math.round(v));
    return pad(Math.floor(v / 60)) + ':' + pad(v % 60);
  }

  function sectionTimes() {
    var out = {};
    state.sections.forEach(function (blk) {
      var parts = String(blk.time || '').split('-');
      var a = toMin(parts[0]);
      var b = toMin(parts[1]);
      if (a === null || b === null || b <= a) return;
      var n = Math.max(1, blk.end - blk.start + 1);
      var step = (b - a) / n;
      for (var i = 0; i < n; i++) {
        out[blk.start + i] = {
          start: fromMin(a + i * step),
          end: fromMin(a + (i + 1) * step)
        };
      }
    });
    return out;
  }

  function sectionRows(times) {
    var seen = {};
    state.courses.forEach(function (c) {
      for (var s = c.start_section; s <= c.end_section; s++) seen[s] = 1;
    });
    if (!state.sections.length) {
      return SECTION_ORDER.filter(function (n) { return seen[n]; })
        .map(function (n) { return { sec: n, time: null }; });
    }
    return SECTION_ORDER.filter(function (n) { return times[n]; })
      .map(function (n) { return { sec: n, time: times[n] }; });
  }

  function timeLabel(times, startSec, endSec) {
    var a = times[startSec] ? times[startSec].start : '';
    var b = times[endSec] ? times[endSec].end : (times[startSec] ? times[startSec].end : '');
    if (!a && !b) return '';
    return b && b !== a ? a + '-' + b : a;
  }

  function renderSchedule() {
    var grid = el.grid;
    grid.textContent = '';

    if (!state.courses.length) {
      grid.style.display = 'none';
      showState({
        title: '还没有课表数据',
        text: '定时任务跑通后会自动出现，也可以点右上角刷新。'
      });
      return;
    }
    clearState();
    grid.style.display = 'grid';

    var week = state.week;
    var filtered = state.courses.filter(function (c) {
      var w = parseWeeks(c.weeks);
      if (w.empty) return true;
      return !!w.set[week];
    });

    var times = sectionTimes();
    var rows = sectionRows(times);
    var rowIndex = {};
    rows.forEach(function (r, i) { rowIndex[r.sec] = i + 1; });

    grid.style.gridTemplateRows = 'var(--head-h) repeat(' + rows.length + ', minmax(0, 1fr))';

    var monday = mondayOfWeek(week);
    var today = startOfDay(new Date());

    var corner = document.createElement('div');
    corner.className = 'corner';
    grid.appendChild(corner);

    for (var d = 1; d <= 7; d++) {
      var head = document.createElement('div');
      var dateObj = monday ? addDays(monday, d - 1) : null;
      var isToday = !!(dateObj && dateObj.getTime() === today.getTime());
      head.className = 'day-head' + (isToday ? ' is-today' : '');

      var nm = document.createElement('span');
      nm.className = 'day-name';
      nm.textContent = WEEK_NAMES[d - 1];
      head.appendChild(nm);

      var dt = document.createElement('span');
      dt.className = 'day-date';
      dt.textContent = dateObj ? (pad(dateObj.getMonth() + 1) + '/' + pad(dateObj.getDate())) : '';
      head.appendChild(dt);
      grid.appendChild(head);
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var no = document.createElement('div');
      no.className = 'sec-no';
      no.style.gridColumn = '1';
      no.style.gridRow = String(i + 2);
      var b = document.createElement('b');
      b.textContent = row.sec;
      no.appendChild(b);
      if (row.time) {
        [row.time.start, row.time.end].forEach(function (p) {
          var sp = document.createElement('span');
          sp.textContent = p;
          no.appendChild(sp);
        });
      }
      grid.appendChild(no);

      for (var c2 = 1; c2 <= 7; c2++) {
        var line = document.createElement('div');
        line.className = 'cell-line';
        line.style.gridColumn = String(c2 + 1);
        line.style.gridRow = String(i + 2);
        grid.appendChild(line);
      }
    }

    var stacks = {};
    filtered.forEach(function (c) {
      var rs = rowIndex[c.start_section];
      if (!rs) return;
      var re = rowIndex[c.end_section] || rs;
      if (re < rs) re = rs;
      var key = c.weekday + '-' + rs + '-' + re;
      if (!stacks[key]) stacks[key] = { weekday: c.weekday, rs: rs, re: re, items: [] };
      stacks[key].items.push(c);
    });

    Object.keys(stacks).forEach(function (key) {
      var s = stacks[key];
      var stack = document.createElement('div');
      stack.className = 'course-stack' + (s.items.length > 1 ? ' is-multi' : '');
      stack.style.gridColumn = String(s.weekday + 1);
      stack.style.gridRow = (s.rs + 1) + ' / span ' + (s.re - s.rs + 1);

      s.items.forEach(function (c) {
        var block = document.createElement('div');
        block.className = 'course theme-' + paletteIndex(c.course_name || 'x');

        var name = document.createElement('div');
        name.className = 'c-name';
        name.textContent = c.course_name || '未命名课程';
        block.appendChild(name);

        var tl = timeLabel(times, c.start_section, c.end_section);
        if (tl) {
          var tm = document.createElement('div');
          tm.className = 'c-time';
          tm.textContent = tl;
          block.appendChild(tm);
        }

        if (c.location) {
          var loc = document.createElement('div');
          loc.className = 'c-loc';
          loc.textContent = shortLoc(c.location) || c.location;
          block.appendChild(loc);
        }

        block.addEventListener('click', function () {
          var parts = [c.course_name];
          if (c.teacher) parts.push('教师：' + c.teacher);
          if (c.location) parts.push('地点：' + c.location);
          parts.push('时间：' + WEEK_NAMES[(c.weekday || 1) - 1] + ' 第' + c.start_section + '-' + c.end_section + '节');
          if (c.weeks) parts.push('周次：' + c.weeks);
          toast(parts.join(' · '));
        });

        stack.appendChild(block);
      });

      grid.appendChild(stack);
    });

    el.weekLabel.textContent = '第 ' + week + ' 周';
  }

  /* ---------------- 加载 ---------------- */

  function setBusy(on) {
    state.busy = on;
    el.refresh.classList.toggle('is-busy', on);
    el.refresh.disabled = on;
  }

  function loadAll(showToast) {
    if (state.busy) return Promise.resolve();
    setBusy(true);
    el.stamp.textContent = '加载中…';

    return fetchJSON('data/schedule.json').then(function (data) {
      state.courses = Array.isArray(data.courses) ? data.courses : [];
      state.sections = Array.isArray(data.sections) ? data.sections : [];
      state.term = data.term || '';
      state.termStart = data.term_start ? new Date(data.term_start + 'T00:00:00') : null;

      var maxW = 18;
      state.courses.forEach(function (c) {
        var w = parseWeeks(c.weeks);
        if (w.max > maxW) maxW = w.max;
      });
      state.maxWeek = Math.min(maxW, 30);

      if (!state.week || state.week < 1) state.week = currentWeek();
      if (state.week > state.maxWeek) state.week = state.maxWeek;

      el.termLabel.textContent = state.term;
      renderSchedule();

      el.stamp.textContent = (fmtStamp(data.updated_at) || '尚无数据') +
        (data.updated_at ? '（' + agoText(data.updated_at) + '）' : '') + ' · ' + checkStamp();

      setBusy(false);
      if (showToast) {
        var now = new Date();
        toast('已检查 ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) +
          (data.updated_at ? ' · 数据 ' + agoText(data.updated_at) : ''));
      }
    }).catch(function (err) {
      el.grid.style.display = 'none';
      showState({
        title: '课表加载失败',
        text: '网络不通或数据还没生成（' + err.message + '）',
        retry: true,
        error: true
      });
      el.stamp.textContent = '';
      setBusy(false);
      if (showToast) toast('刷新失败，请检查网络');
    });
  }

  /* ---------------- 交互 ---------------- */

  el.prevWeek.addEventListener('click', function () {
    if (state.week > 1) { state.week -= 1; renderSchedule(); }
  });

  el.nextWeek.addEventListener('click', function () {
    if (state.week < state.maxWeek) { state.week += 1; renderSchedule(); }
  });

  el.thisWeek.addEventListener('click', function () {
    state.week = currentWeek();
    renderSchedule();
    var head = el.grid.querySelector('.day-head.is-today');
    var no = el.grid.querySelector('.sec-no');
    var secW = no ? no.offsetWidth : 46;
    if (head) el.gridScroll.scrollLeft = Math.max(0, head.offsetLeft - secW);
    toast('已跳到第 ' + state.week + ' 周');
  });

  el.refresh.addEventListener('click', function () { loadAll(true); });

  /* ---------------- 深浅色 ---------------- */

  var THEME_KEY = 'campus-theme';
  var themeBtn = document.getElementById('theme-toggle');
  var themeIcon = document.getElementById('theme-icon');
  var darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY) || ''; } catch (e) { return ''; }
  }

  function isDark() {
    return document.documentElement.dataset.theme === 'dark';
  }

  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeIcon.textContent = dark ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', dark ? '切换到浅色' : '切换到深色');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1218' : '#f6f7f9');
  }

  function followSystem() {
    var t = savedTheme();
    applyTheme(t === 'dark' || (!t && darkMedia.matches));
  }

  followSystem();
  if (darkMedia.addEventListener) {
    darkMedia.addEventListener('change', followSystem);
  } else if (darkMedia.addListener) {
    darkMedia.addListener(followSystem);
  }

  themeBtn.addEventListener('click', function () {
    var dark = !isDark();
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    applyTheme(dark);
    toast(dark ? '已切换到深色' : '已切换到浅色');
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !state.courses.length) loadAll();
  });

  loadAll();
})();
