
class Component extends DCLogic {
  config = {
    news: { label: 'お知らせ', hasBody: true,
      h1: 'カテゴリ', h2: 'タイトル', h3: '掲載日',
      fields: [
        { key: 'tag', label: 'カテゴリ', ph: '例: 重要 / 総務 / 安全' },
        { key: 'title', label: 'タイトル', ph: '例: 夏季休業期間のお知らせ' },
        { key: 'date', label: '掲載日', ph: '例: 7/18' }
      ],
      cells: it => [it.tag, it.title, it.date] },
    schedule: { label: '全社スケジュール', hasBody: true,
      h1: '日付', h2: '行事名', h3: '補足(場所など)',
      fields: [
        { key: 'date', label: '日付', ph: '例: 7/24' },
        { key: 'title', label: '行事名', ph: '例: 全社朝会' },
        { key: 'sub', label: '補足(場所など)', ph: '例: 9:00– 全社員' }
      ],
      cells: it => [it.date, it.title, it.sub] },
    links: { label: 'クイックリンク', hasBody: false,
      h1: 'アイコン文字', h2: '名称', h3: 'リンク先URL',
      fields: [
        { key: 'char', label: 'アイコン文字(1文字)', ph: '例: 勤' },
        { key: 'label', label: '名称', ph: '例: 勤怠管理' },
        { key: 'url', label: 'リンク先URL', ph: '例: https://…' }
      ],
      cells: it => [it.char, it.label, it.url] }
  };
  defaults = {
    news: [
      { tag: '重要', title: '夏季休業期間のお知らせ(8/11〜8/15)', date: '7/17', body: '本年度の夏季休業期間は 8月11日(火)〜8月15日(土) の5日間です。' },
      { tag: '総務', title: '健康診断の予約受付を開始しました', date: '7/16', body: '実施期間: 7月28日(火)〜8月8日(土)。予約はポータルの「健康診断予約」リンクから。' },
      { tag: '安全', title: '7月度 安全衛生委員会の議事録を掲載', date: '7/15', body: '主な議題: 熱中症対策の徹底、指摘事項と是正状況、保護具の点検スケジュール。' },
      { tag: '人事', title: '中途入社者のご紹介(工事部 2名)', date: '7/14', body: '7月1日付で工事部に2名が入社しました。歓迎会は 7/31(金) を予定しています。' },
      { tag: 'IT', title: '社内Wi-Fi機器更新に伴う一時停止(7/26 夜間)', date: '7/11', body: '停止日時: 7月26日(日) 22:00〜翌5:00。影響範囲: 本社全フロアの Wi-Fi。' }
    ],
    schedule: [
      { date: '7/24', title: '全社朝会(オンライン配信)', sub: '9:00– 全社員', body: '月例の全社朝会をオンライン配信で実施します。' },
      { date: '8/1', title: '創立記念日(休業日)', sub: '全社休業', body: '創立記念日のため全社休業です。緊急連絡は総務部 内線100まで。' },
      { date: '8/20', title: '下期キックオフ総会', sub: '本社ホール / 配信あり', body: '下期方針の共有と部門目標の発表を行います。15:00〜17:00。' },
      { date: '9/5', title: '全社防災訓練', sub: '各拠点 10:00–', body: '全拠点一斉の防災訓練を実施します。' }
    ],
    links: [
      { char: '勤', label: '勤怠管理', url: 'https://example.com/kintai' },
      { char: '経', label: '経費精算', url: 'https://example.com/expense' },
      { char: '申', label: '各種申請', url: 'https://example.com/apply' },
      { char: '会', label: '会議室予約', url: 'https://example.com/rooms' },
      { char: '工', label: '工事台帳', url: 'https://example.com/koji' },
      { char: '図', label: '図面管理', url: 'https://example.com/zumen' },
      { char: '名', label: '社員名簿', url: 'https://example.com/meibo' },
      { char: 'IT', label: 'ITサポート', url: 'https://example.com/support' }
    ]
  };
  state = { tab: 'news', data: null, draft: null, editIndex: -1 };
  componentDidMount() {
    let data;
    try { data = JSON.parse(localStorage.getItem('yoshimura-portal-admin-v2') || 'null'); } catch (e) { data = null; }
    this.setState({ data: data || this.defaults });
  }
  persist(data) {
    this.setState({ data });
    try { localStorage.setItem('yoshimura-portal-admin-v2', JSON.stringify(data)); } catch (e) {}
  }
  renderVals() {
    const { tab, draft, editIndex } = this.state;
    const data = this.state.data || this.defaults;
    const cfg = this.config[tab];
    const items = data[tab] || [];
    const mutate = fn => this.persist({ ...data, [tab]: fn([...items]) });
    const body = draft ? (draft.body || '') : '';
    return {
      tabs: Object.keys(this.config).map(k => {
        const sel = k === tab;
        return { label: this.config[k].label, count: `${(data[k] || []).length}件`,
          bg: sel ? '#1e5fa8' : '#ffffff', color: sel ? '#ffffff' : '#1c2b3a',
          border: sel ? '#1e5fa8' : '#dfe8f0', countColor: sel ? '#bcd4ef' : '#8a99a8',
          select: () => this.setState({ tab: k, draft: null, editIndex: -1 }) };
      }),
      h1: cfg.h1, h2: cfg.h2, h3: cfg.h3,
      rows: items.map((it, i) => {
        const c = cfg.cells(it);
        return { c1: c[0], c2: c[1], c3: c[2],
          edit: () => this.setState({ draft: { ...it }, editIndex: i }),
          del: () => { mutate(a => (a.splice(i, 1), a)); } };
      }),
      isEmpty: items.length === 0,
      formOpen: !!draft,
      formTitle: `${cfg.label} — ${editIndex >= 0 ? '編集' : '新規追加'}`,
      saveLabel: editIndex >= 0 ? '更新する' : '追加する',
      openNew: () => this.setState({ draft: {}, editIndex: -1 }),
      fields: cfg.fields.map(f => ({
        label: f.label, placeholder: f.ph, value: draft ? (draft[f.key] || '') : '',
        onChange: e => this.setState({ draft: { ...this.state.draft, [f.key]: e.target.value } })
      })),
      hasBody: !!cfg.hasBody,
      bodyValue: body,
      bodyCount: body.length,
      bodyCountColor: body.length >= 500 ? '#c05a5a' : '#8a99a8',
      bodyMax: 500,
      bodyRows: 7,
      bodyChange: e => this.setState({ draft: { ...this.state.draft, body: e.target.value.slice(0, 500) } }),
      save: () => {
        const dr = this.state.draft || {};
        if (!cfg.fields.some(f => (dr[f.key] || '').trim())) return;
        const entry = {};
        cfg.fields.forEach(f => entry[f.key] = (dr[f.key] || '').trim());
        if (cfg.hasBody) entry.body = (dr.body || '').slice(0, 500);
        mutate(a => { editIndex >= 0 ? a[editIndex] = entry : a.push(entry); return a; });
        this.setState({ draft: null, editIndex: -1 });
      },
      cancel: () => this.setState({ draft: null, editIndex: -1 }),
      stopClick: e => e.stopPropagation()
    };
  }
}
