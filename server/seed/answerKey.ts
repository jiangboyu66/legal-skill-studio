/**
 * Issues deliberately planted in the fictional high-risk EDM (HIGH_RISK_EDM).
 * Used by `npm run demo:real` to estimate recall of the real model run. Not used at runtime.
 * `anchor` is a short verbatim fragment of the material; `rules` are acceptable rule IDs from the rule pack.
 */
export interface ExpectedIssue {
  id: string;
  description: string;
  anchor: string;
  rules: string[];
}

export const HIGH_RISK_ANSWER_KEY: ExpectedIssue[] = [
  { id: 'K1', description: '“No.1”最高级用语需要证明', anchor: 'No.1', rules: ['SCAP-04', 'SCAP-02', 'CPFTA-01'] },
  { id: 'K2', description: '“50,000+ 用户”数量声明需要证明', anchor: '50,000', rules: ['SCAP-04', 'SCAP-02'] },
  { id: 'K3', description: '“临床证明治愈背痛”的科学/健康功效声明', anchor: 'clinically proven', rules: ['SCAP-03', 'SCAP-04', 'CPFTA-01', 'INT-03'] },
  { id: 'K4', description: '原价/现价对比的真实性', anchor: 'WAS $2,999', rules: ['PRICE-01', 'SCAP-02'] },
  { id: 'K5', description: '“仅限今天”与活动期 1–15 Nov 矛盾（虚假紧迫）', anchor: 'TODAY ONLY', rules: ['CPFTA-02', 'SCAP-02'] },
  { id: 'K6', description: '“免费配送”与小字中的运费条件矛盾', anchor: 'FREE delivery', rules: ['PRICE-01', 'CPFTA-03', 'SCAP-02'] },
  { id: 'K7', description: '赠品条件（while stocks last）放在小字', anchor: 'FREE pillows', rules: ['CPFTA-03', 'PRICE-01', 'SCAP-02'] },
  { id: 'K8', description: '医生背书/证言需核实', anchor: 'Dr. Tan', rules: ['SCAP-05'] },
  { id: 'K9', description: '贬低竞争对手', anchor: 'Brand X', rules: ['INT-02', 'SCAP-02'] },
  { id: 'K10', description: '“终身耐用”无依据', anchor: 'lasts a lifetime', rules: ['SCAP-04', 'SCAP-02', 'CPFTA-01'] },
  { id: 'K11', description: '抽奖收集 NRIC 号码', anchor: 'NRIC', rules: ['NRIC-01', 'PDPA-01'] },
  { id: 'K12', description: '通过短信/WhatsApp 营销需查 DNC 或取得同意', anchor: 'SMS and WhatsApp', rules: ['PDPA-02'] },
  { id: 'K13', description: '批量营销邮件缺少退订方式与 <ADV> 标签', anchor: '11.11 MEGA SALE', rules: ['SPAM-01'] },
  { id: 'K14', description: '未链接完整条款（Other T&Cs apply）', anchor: 'T&Cs', rules: ['INT-01', 'CPFTA-03'] },
];
