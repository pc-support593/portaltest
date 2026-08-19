
class Component extends DCLogic {
  siteList = [
    { id: 'hq', name: '平野展示場' },
    { id: 'osaka', name: '花博展示場' },
    { id: 'sendai', name: '中百舌鳥展示場' },
    { id: 'site', name: '福田展示場' }
  ];
  roomList = [
    { id: 'a', site: 'hq', name: '会議室A', meta: '3F ・ 12名 ・ TV会議', color: '#2e6fc0' },
    { id: 'b', site: 'hq', name: '会議室B', meta: '3F ・ 6名 ・ モニタ', color: '#2e7d52' },
    { id: 'hall', site: 'hq', name: '大会議室', meta: '1F ・ 40名 ・ 配信設備', color: '#7b5ea8' },
    { id: 'ex', site: 'hq', name: '応接室', meta: '2F ・ 4名', color: '#b8571f' },
    { id: 'os1', site: 'osaka', name: '会議室1', meta: '5F ・ 10名 ・ TV会議', color: '#2e6fc0' },
    { id: 'os2', site: 'osaka', name: '会議室2', meta: '5F ・ 6名', color: '#2e7d52' },
    { id: 'osex', site: 'osaka', name: '応接室', meta: '5F ・ 4名', color: '#b8571f' },
    { id: 'sd1', site: 'sendai', name: '打合せ室', meta: '2F ・ 8名 ・ モニタ', color: '#33718f' },
    { id: 'sd2', site: 'sendai', name: '小会議室', meta: '2F ・ 4名', color: '#7b5ea8' },
    { id: 'gen', site: 'site', name: '商談室', meta: '1F ・ 8名', color: '#33718f' },
    { id: 'gen2', site: 'site', name: 'セミナールーム', meta: '2F ・ 20名', color: '#2e7d52' }
  ];
  // 曜日パターンで擬似的な予約を生成(day = 日付, dow = 曜日)
  patterns = {
    a: [
      { dow: 1, time: '10:00', end: '11:00', title: '営業企画 定例MTG', owner: '佐藤 美咲', mine: true },
      { dow: 3, time: '14:00', end: '15:30', title: '協力会社 打合せ', owner: '田中 健太' },
      { dow: 4, time: '09:00', end: '10:00', title: '工程確認', owner: '鈴木 花子' }
    ],
    b: [
      { dow: 2, time: '13:00', end: '14:00', title: '採用面接', owner: '人事部' },
      { dow: 5, time: '16:00', end: '17:00', title: '週次レビュー', owner: '佐藤 美咲', mine: true }
    ],
    hall: [
      { dow: 5, time: '08:30', end: '09:30', title: '全体朝礼', owner: '総務部' },
      { dow: 2, time: '15:00', end: '17:00', title: '安全大会 準備', owner: '安全衛生委員会' }
    ],
    ex: [
      { dow: 1, time: '11:00', end: '12:00', title: '来客(○○商事様)', owner: '営業部' },
      { dow: 4, time: '15:00', end: '16:00', title: '来客(△△工業様)', owner: '営業部' }
    ],
    gen: [
      { dow: 1, time: '08:00', end: '08:30', title: '朝礼・KY活動', owner: '工事部' },
      { dow: 3, time: '13:00', end: '14:00', title: '施工打合せ', owner: '工事部' }
    ],
    gen2: [
      { dow: 2, time: '08:00', end: '09:00', title: '安全パトロール前ミーティング', owner: '安全衛生委員会' },
      { dow: 4, time: '16:00', end: '17:00', title: '協力会社 安全教育', owner: '工事部' }
    ],
    os1: [
      { dow: 1, time: '09:30', end: '11:00', title: '関西営業 週次会議', owner: '大阪支店 営業' },
      { dow: 3, time: '14:00', end: '16:00', title: '見積レビュー', owner: '積算課' }
    ],
    os2: [
      { dow: 2, time: '10:00', end: '11:00', title: '協力会社 打合せ', owner: '大阪支店 工事' },
      { dow: 5, time: '13:00', end: '14:00', title: '本社定例(TV会議)', owner: '佐藤 美咲', mine: true }
    ],
    osex: [
      { dow: 4, time: '11:00', end: '12:00', title: '来客(□□建材様)', owner: '大阪支店 営業' }
    ],
    sd1: [
      { dow: 1, time: '13:00', end: '14:30', title: '東北エリア 工程会議', owner: '仙台営業所' },
      { dow: 4, time: '10:00', end: '11:00', title: '採用説明会 準備', owner: '人事部' }
    ],
    sd2: [
      { dow: 3, time: '15:00', end: '16:00', title: '個別面談', owner: '仙台営業所' }
    ]
  };
  state = { site: 'hq', room: 'a', ym: null, day: null, mine: [], form: null };
  componentDidMount() {
    const n = new Date();
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem('yoshimura-room-bookings') || '[]'); } catch (e) { mine = []; }
    this.setState({ ym: { y: n.getFullYear(), m: n.getMonth() }, mine });
  }
  persistMine(mine) {
    this.setState({ mine });
    try { localStorage.setItem('yoshimura-room-bookings', JSON.stringify(mine)); } catch (e) {}
  }
  key(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  tint(hex, ratio) {
    const n = parseInt(hex.slice(1), 16);
    const mix = c => Math.round(c + (255 - c) * ratio);
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }
  shade(hex, ratio) {
    const n = parseInt(hex.slice(1), 16);
    const mix = c => Math.round(c * (1 - ratio));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }
  bookingsFor(roomId, date) {
    const dow = date.getDay();
    const base = (dow === 0 || dow === 6) ? [] : (this.patterns[roomId] || []).filter(p => p.dow === dow).map(p => ({ ...p }));
    const k = this.key(date);
    const own = (this.state.mine || []).filter(b => b.room === roomId && b.date === k).map(b => ({ ...b, mine: true, user: true }));
    return base.concat(own).sort((x, y) => x.time.localeCompare(y.time));
  }
  renderVals() {
    const now = new Date();
    const ym = this.state.ym || { y: now.getFullYear(), m: now.getMonth() };
    const siteId = this.state.site;
    const site = this.siteList.find(s => s.id === siteId);
    const siteRooms = this.roomList.filter(r => r.site === siteId);
    const isAll = this.state.room === '__all';
    const roomId = isAll ? '__all' : (siteRooms.some(r => r.id === this.state.room) ? this.state.room : siteRooms[0].id);
    const room = isAll
      ? { name: '全ての会議室', meta: `${siteRooms.length}室すべての予約を表示`, color: '#5a6a7a' }
      : this.roomList.find(r => r.id === roomId);
    const first = new Date(ym.y, ym.m, 1);
    const start = new Date(ym.y, ym.m, 1 - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && d.getMonth() !== ym.m) break;
      const inMonth = d.getMonth() === ym.m;
      const isToday = d.toDateString() === now.toDateString();
      const dow = d.getDay();
      let bks = [];
      if (inMonth) {
        if (isAll) {
          siteRooms.forEach(r => this.bookingsFor(r.id, d).forEach(b => bks.push({ ...b, roomName: r.name, roomColor: r.color })));
          bks.sort((x, y) => x.time.localeCompare(y.time));
        } else {
          bks = this.bookingsFor(roomId, d);
        }
      }
      cells.push({
        day: d.getDate(),
        weekIndex: Math.floor(i / 7),
        bg: !inMonth ? '#fbfcfd' : dow === 0 ? '#fdf7f7' : dow === 6 ? '#f7fafd' : '#ffffff',
        dateColor: !inMonth ? '#c5cfda' : isToday ? '#ffffff' : dow === 0 ? '#c05a5a' : dow === 6 ? '#2f6f8f' : '#1c2b3a',
        dateBg: isToday ? '#1e5fa8' : 'transparent',
        countLabel: inMonth && bks.length ? `${bks.length}件` : '',
        bookings: bks.map(b => {
          const rc = b.roomColor || room.color;
          return {
            time: `${b.time}–${b.end}`, title: b.title,
            roomTag: `/ ${b.roomName || room.name}`,
            bg: rc,
            bar: b.mine ? '#f5b301' : rc,
            timeColor: 'rgba(255,255,255,0.93)',
            titleColor: '#ffffff'
          };
        }),
        open: inMonth ? () => this.setState({ day: { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() } }) : () => {}
      });
    }
    const dayState = this.state.day;
    let slots = [], dayTitle = '';
    if (dayState) {
      const dd = new Date(dayState.y, dayState.m, dayState.d);
      const w = ['日', '月', '火', '水', '木', '金', '土'][dd.getDay()];
      dayTitle = `${dayState.m + 1}月${dayState.d}日(${w}) の空き状況`;
      if (isAll) {
        const all = [];
        siteRooms.forEach(r => this.bookingsFor(r.id, dd).forEach(b => all.push({ ...b, roomName: r.name, roomColor: r.color })));
        all.sort((x, y) => x.time.localeCompare(y.time));
        slots = all.length
          ? all.map(b => ({ time: `${b.time}–${b.end}`, label: b.title, owner: b.owner, weight: '700',
              textColor: '#ffffff', subColor: 'rgba(255,255,255,0.93)', bg: b.roomColor,
              bar: b.mine ? '#f5b301' : b.roomColor, free: false,
              hasRoom: true, roomLabel: b.roomName, roomColor: '#ffffff',
              chipBg: 'rgba(255,255,255,0.18)', chipColor: '#ffffff',
              mineTag: !!b.mine,
              cancelable: !!b.user, cancel: b.user ? () => this.persistMine(this.state.mine.filter(x => x.id !== b.id)) : null }))
          : [{ time: '', label: 'この日の予約はありません', owner: '', weight: '500', textColor: '#8a99a8', subColor: '#8a99a8', bg: '#fbfcfd', bar: '#e8edf3', free: false, hasRoom: false, roomLabel: '', chipBg: 'transparent', chipColor: '#8a99a8', mineTag: false }];
      } else {
        const bks = this.bookingsFor(roomId, dd);
        for (let h = 8; h <= 18; h++) {
          const label = `${String(h).padStart(2, '0')}:00`;
          const hit = bks.find(b => {
            const s = parseInt(b.time, 10), e = parseInt(b.end, 10);
            return h >= s && h < e;
          });
          slots.push(hit
            ? { time: label, label: hit.title, owner: hit.owner, weight: '700',
                textColor: '#ffffff', subColor: 'rgba(255,255,255,0.93)',
                bg: room.color, bar: hit.mine ? '#f5b301' : room.color,
                hasRoom: true, roomLabel: room.name, roomColor: '#ffffff',
                chipBg: 'rgba(255,255,255,0.18)', chipColor: '#ffffff', mineTag: !!hit.mine,
                free: false, cancelable: !!hit.user, id: hit.id || '',
                cancel: hit.user ? () => this.persistMine(this.state.mine.filter(b => b.id !== hit.id)) : null }
            : { time: label, label: '空き', owner: '', weight: '500', textColor: '#8a99a8', subColor: '#8a99a8', bg: '#fbfcfd', bar: '#e8edf3', free: true,
                hasRoom: false, roomLabel: '', chipBg: 'transparent', chipColor: '#8a99a8', mineTag: false,
                book: () => this.setState({ form: { room: roomId, date: this.key(dd), start: label, end: `${String(h + 1).padStart(2, '0')}:00`, title: '', people: '' } }) });
        }
      }
    }
    const weekOnly = typeof this.state.week === 'number' ? this.state.week : null;
    let weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      const days = cells.slice(i, i + 7);
      const wi = i / 7;
      const sel = weekOnly === wi;
      const firstDay = days[0], lastDay = days[days.length - 1];
      weeks.push({
        days,
        label: sel ? '月間' : `第${wi + 1}週`,
        range: `${firstDay.day}日〜${lastDay.day}日`,
        bg: sel ? '#1e5fa8' : '#f7fafd',
        color: sel ? '#ffffff' : '#6b7d8f',
        toggle: () => this.setState({ week: sel ? null : wi, day: null })
      });
    }
    if (weekOnly !== null && weeks[weekOnly]) weeks = [weeks[weekOnly]];
    const form = this.state.form;
    const hours = [];
    for (let h = 8; h <= 20; h++) { hours.push(`${String(h).padStart(2, '0')}:00`); hours.push(`${String(h).padStart(2, '0')}:30`); }
    const shift = n => {
      const d = new Date(ym.y, ym.m + n, 1);
      this.setState({ ym: { y: d.getFullYear(), m: d.getMonth() }, day: null, week: null });
    };
    return {
      sites: this.siteList.map(s => {
        const sel = s.id === siteId;
        const n = this.roomList.filter(r => r.site === s.id).length;
        return { name: s.name, count: `${n}室`,
          bg: sel ? '#1e5fa8' : '#ffffff', color: sel ? '#ffffff' : '#1c2b3a',
          subColor: sel ? '#bcd4ef' : '#8a99a8',
          border: sel ? '#1e5fa8' : '#dfe8f0',
          select: () => {
            const first = this.roomList.find(r => r.site === s.id);
            this.setState({ site: s.id, room: first ? first.id : null, day: null });
          } };
      }),
      siteName: site.name,
      roomCount: `${siteRooms.length}室`,
      rooms: [{
        name: '全ての会議室', meta: `${siteRooms.length}室をまとめて表示`, color: '#5a6a7a',
        bg: isAll ? '#eef4fb' : '#ffffff',
        border: isAll ? '#2e6fc0' : '#eef1f5',
        select: () => this.setState({ room: '__all', day: null })
      }].concat(siteRooms.map(r => ({
        name: r.name, meta: r.meta, color: r.color,
        bg: r.id === roomId ? '#eef4fb' : '#ffffff',
        border: r.id === roomId ? '#2e6fc0' : '#eef1f5',
        select: () => this.setState({ room: r.id, day: null })
      }))),
      activeName: isAll ? `${site.name} ・ 全ての会議室` : `${site.name} ${room.name}`, activeMeta: room.meta, activeColor: room.color,
      monthLabel: `${ym.y}年 ${ym.m + 1}月`,
      weekdays: ['月', '火', '水', '木', '金', '土', '日'].map((l, i) => ({
        label: l, color: i === 6 ? '#c05a5a' : i === 5 ? '#2f6f8f' : '#6b7d8f'
      })),
      weeks,
      weekMode: weekOnly !== null,
      weekModeLabel: weekOnly !== null && weeks[0] ? `${weeks[0].range} の週を表示中` : '',
      exitWeek: () => this.setState({ week: null }),
      prevMonth: () => shift(-1),
      nextMonth: () => shift(1),
      thisMonth: () => this.setState({ ym: { y: now.getFullYear(), m: now.getMonth() }, day: null, week: null }),
      syncTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      dayOpen: !!dayState,
      dayTitle, slots,
      canQuickBook: !isAll && !!dayState,
      quickBook: () => dayState && this.setState({ form: { room: roomId, date: `${dayState.y}-${dayState.m + 1}-${dayState.d}`, start: '09:00', end: '10:00', title: '', people: '' } }),
      closeDay: () => this.setState({ day: null }),
      formOpen: !!form,
      formRoom: form ? (this.roomList.find(r => r.id === form.room) || {}).name || '' : '',
      formSite: site.name,
      formDate: form ? form.date.split('-').slice(1).join('/') : '',
      formTitle: form ? form.title : '',
      formStart: form ? form.start : '',
      formEnd: form ? form.end : '',
      formPeople: form ? form.people : '',
      hourOptions: hours,
      setFormTitle: e => this.setState({ form: { ...this.state.form, title: e.target.value } }),
      setFormStart: e => this.setState({ form: { ...this.state.form, start: e.target.value } }),
      setFormEnd: e => this.setState({ form: { ...this.state.form, end: e.target.value } }),
      setFormPeople: e => this.setState({ form: { ...this.state.form, people: e.target.value } }),
      formError: form && form.start >= form.end ? '終了時刻は開始時刻より後にしてください' : '',
      cancelForm: () => this.setState({ form: null }),
      submitForm: () => {
        const f = this.state.form;
        if (!f || !f.title.trim() || f.start >= f.end) return;
        const entry = { id: `b${Date.now()}`, room: f.room, date: f.date, time: f.start, end: f.end,
          title: f.title.trim(), owner: f.people.trim() ? `佐藤 美咲 ・ ${f.people.trim()}` : '佐藤 美咲' };
        this.persistMine((this.state.mine || []).concat(entry));
        this.setState({ form: null });
      },
      stopClick: e => e.stopPropagation()
    };
  }
}
