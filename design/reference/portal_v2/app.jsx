
class Component extends DCLogic {
  state = { modal: null };
  news = [
    { date: '7/17', tag: '重要', owner: '総務部', title: '夏季休業期間のお知らせ(8/11〜8/15)',
      body: '本年度の夏季休業期間は 8月11日(火)〜8月15日(土) の5日間です。\n\n・休業中の緊急連絡は総務部 内線100(転送対応)まで\n・現場の稼働予定は各工事部長の指示に従ってください\n・休業前日の 8/10 は 16:00 までに戸締り・電源確認をお願いします\n\n休暇申請システムへの入力は不要です。' },
    { date: '7/16', tag: '総務', owner: '総務部', title: '健康診断の予約受付を開始しました',
      body: '本社・各営業所の定期健康診断の予約受付を開始しました。\n\n実施期間: 7月28日(火)〜8月8日(土)\n会場: 本社2F 多目的室(営業所は巡回健診車)\n\n予約はポータルの「健康診断予約」リンク、または総務部 内線102 まで。受診時は保険証と問診票をご持参ください。' },
    { date: '7/15', tag: '安全', owner: '安全衛生委員会', title: '7月度 安全衛生委員会の議事録を掲載',
      body: '7月度 安全衛生委員会(7/14 開催)の議事録を社内ドキュメントに掲載しました。\n\n主な議題:\n・熱中症対策の徹底(WBGT値の測定と休憩ルール)\n・○○現場での指摘事項と是正状況\n・保護具の点検・交換スケジュール\n\n各現場責任者は朝礼での周知をお願いします。' },
    { date: '7/14', tag: '人事', owner: '人事部', title: '中途入社者のご紹介(工事部 2名)',
      body: '7月1日付で工事部に2名が入社しました。\n\n・佐藤 健一(施工管理・経験12年)\n・田中 美咲(積算・経験5年)\n\n配属は本社工事部です。見かけた際はぜひお声がけください。歓迎会は 7/31(金) を予定しています。' },
    { date: '7/11', tag: 'IT', owner: '情報システム課', title: '社内Wi-Fi機器更新に伴う一時停止(7/26 夜間)',
      body: '社内Wi-Fi機器の更新作業のため、下記の時間帯は本社の無線LANが利用できません。\n\n停止日時: 7月26日(日) 22:00〜翌 5:00\n影響範囲: 本社全フロアの Wi-Fi(有線LANは利用可)\n\n作業完了後、接続に問題がある場合は情報システム課 内線205 までご連絡ください。' }
  ];
  schedule = [
    { month: '7月', day: '24', title: '全社朝会(オンライン配信)', sub: '9:00– 全社員',
      body: '月例の全社朝会をオンライン配信で実施します。\n\n・社長メッセージ\n・各部門トピックス\n・安全表彰\n\n現場からはモバイル端末での視聴が可能です。' },
    { month: '8月', day: '1', title: '創立記念日(休業日)', sub: '全社休業',
      body: '8月1日は創立記念日のため全社休業です。緊急連絡は総務部 内線100(転送対応)までお願いします。' },
    { month: '8月', day: '20', title: '下期キックオフ総会', sub: '本社ホール / 配信あり',
      body: '下期方針の共有と部門目標の発表を行います。\n\n会場: 本社1Fホール(オンライン配信あり)\n時間: 15:00〜17:00\n\n終了後、懇親会を予定しています。' },
    { month: '9月', day: '5', title: '全社防災訓練', sub: '各拠点 10:00–',
      body: '全拠点一斉の防災訓練を実施します。\n\n・避難経路の確認と避難訓練\n・安否確認システムの応答訓練\n\n現場は各現場の避難計画に基づき実施してください。' }
  ];
  tagStyles = { '重要': ['#ffffff', '#d9534f'], '総務': ['#1e5fa8', '#e3edf8'], '安全': ['#2e7d52', '#e5f2ea'], '人事': ['#1e5fa8', '#e3edf8'], 'IT': ['#8a6d1f', '#f7f0dc'] };
  renderVals() {
    const d = new Date();
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    const h = d.getHours();
    const m = this.state.modal;
    return {
      today: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${w})`,
      greeting: h < 11 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'お疲れさまです',
      newsItems: this.news.map(n => {
        const ts = this.tagStyles[n.tag] || ['#1e5fa8', '#e3edf8'];
        return { date: n.date, tag: n.tag, title: n.title, tagColor: ts[0], tagBg: ts[1],
          open: () => this.setState({ modal: { tag: n.tag, tagColor: ts[0], tagBg: ts[1], date: `${n.date} 掲載`, title: n.title, body: n.body, owner: n.owner } }) };
      }),
      scheduleRows: this.schedule.map(s => ({ month: s.month, day: s.day, title: s.title, sub: s.sub,
        open: () => this.setState({ modal: { tag: '全社行事', tagColor: '#2f6f8f', tagBg: '#e5f0f7', date: `${s.month}${s.day}日 ・ ${s.sub}`, title: s.title, body: s.body, owner: '総務部' } }) })),
      modalOpen: !!m,
      modalTitle: m ? m.title : '',
      modalDate: m ? m.date : '',
      modalTag: m ? m.tag : '',
      modalTagColor: m ? m.tagColor : '#1e5fa8',
      modalTagBg: m ? m.tagBg : '#e3edf8',
      modalBody: m ? m.body : '',
      modalOwner: m ? m.owner : '',
      closeModal: () => this.setState({ modal: null }),
      stopClick: e => e.stopPropagation()
    };
  }
}
