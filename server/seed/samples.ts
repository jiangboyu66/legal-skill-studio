import type { SampleMaterial } from '../../shared/types';

// All sample materials are fictional and were written for testing. Any resemblance to real brands is unintended.

export const HIGH_RISK_EDM = `Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF!

Hi there,

Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy sleepers.
Our patented memory foam is clinically proven to cure back pain in just 7 nights.
WAS $2,999 – NOW ONLY $899! This 70% OFF deal ends TODAY ONLY – don't miss out!
Enjoy FREE delivery and FREE pillows worth $199* with every purchase.
"Best sleep of my life – I recommend it to all my patients." – Dr. Tan, Back Specialist
Unlike cheap Brand X mattresses that sag within a year, CloudRest lasts a lifetime.

LUCKY DRAW: Stand a chance to win a Bali holiday! Simply reply with your full name, NRIC number and mobile number.
We will also send you exclusive deals via SMS and WhatsApp.

Shop now at nimbussleep.example.sg

*Promotion period: 1–15 Nov 2026. Delivery fee of $49 applies to orders below $1,500. Free pillows while stocks last. Other T&Cs apply.
Nimbus Sleep Pte. Ltd. (fictional company for testing)`;

export const LOW_RISK_POST = `Nimbus CloudRest is now available in Singapore.
Our CloudRest mattress has 7 support zones and a removable, washable cover.
Launch offer: 15% off CloudRest Queen (usual price $1,299, now $1,104) from 1 to 30 Nov 2026. Prices include GST.
Delivery fee of $49 applies to orders below $500.
Try it for 100 nights – if it is not right for you, return it for a full refund (conditions apply, see T&Cs).
Full terms and conditions: nimbussleep.example.sg/terms
#Ad #NimbusSleep
Nimbus Sleep Pte. Ltd. (fictional company for testing)`;

export const SAMPLES: (SampleMaterial & { file?: string })[] = [
  {
    id: 'sample_high_edm',
    title: '高风险 EDM（文字，虚构）',
    description: '包含最高级用语、未经证实的健康功效、虚假限时、与小字矛盾的“免费”、医生背书、贬低竞品、收集 NRIC、短信营销、缺少退订与 <ADV> 标签等问题。',
    inputs: { material: HIGH_RISK_EDM, channel: 'EDM（批量营销邮件）', report_language: '简体中文' },
  },
  {
    id: 'sample_low_post',
    title: '低风险社媒帖（文字，虚构）',
    description: '已标注 #Ad、标明含税价格与活动期限、披露运费与条款链接，用于检查系统是否会过度标记。',
    inputs: { material: LOW_RISK_POST, channel: '社交媒体（Instagram）', report_language: '简体中文' },
  },
  {
    id: 'sample_poster_png',
    title: '高风险海报（图片，OCR）',
    description: '一张虚构的促销海报图片，正文大字、条件小字，用于测试 OCR 识别和按页引文核对。',
    inputs: { channel: '户外海报 / 社交媒体图片', report_language: '简体中文' },
    file: 'poster-high-risk.png',
  },
  {
    id: 'sample_edm_pdf',
    title: '两页 EDM（PDF）',
    description: '虚构的两页 PDF 版 EDM，用于测试 PDF 文字层提取和跨页引文定位。',
    inputs: { channel: 'EDM（批量营销邮件）', report_language: '简体中文' },
    file: 'edm-2pages.pdf',
  },
  {
    id: 'sample_post_docx',
    title: '低风险帖子（Word）',
    description: '虚构的 Word 版社媒文案，用于测试 .docx 解析。',
    inputs: { channel: '社交媒体（Instagram）', report_language: '简体中文' },
    file: 'post-low-risk.docx',
  },
];
