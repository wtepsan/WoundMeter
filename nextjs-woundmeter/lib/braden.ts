// Braden Scale reference data shared by the nursing assessment and the wound sign-off form.
// English descriptors are the standard Braden Scale wording; the Thai short labels and criteria are
// the hospital form text carried over unchanged from the former nurse-form app. Scores are
// recalculated on the server (fastapi-woundmeter/app/services/clinical_scoring.py).

export type BradenSubscaleKey =
  | "sensory_perception"
  | "moisture"
  | "activity"
  | "mobility"
  | "nutrition"
  | "friction_and_shear";

export type BradenOption = {
  score: number;
  label: string;
  shortTh: string;
  criterionTh: string;
};

export type BradenSubscale = {
  key: BradenSubscaleKey;
  labelTh: string;
  label: string;
  options: readonly BradenOption[];
};

export const BRADEN_SUBSCALES: readonly BradenSubscale[] = [
  {
    key: "sensory_perception",
    labelTh: "การรับความรู้สึก",
    label: "Sensory perception",
    options: [
      {
        score: 1,
        label: "Completely limited",
        shortTh: "ไม่ตอบสนองหรือสูญเสียความรู้สึกมาก",
        criterionTh:
          "ไม่ตอบสนองต่อสิ่งกระตุ้นให้เกิดความเจ็บปวด เพราะความรู้สึกตัวลดลง หรือได้รับยากล่อมประสาท หรือร่างกายส่วนใหญ่สูญเสียการรับความรู้สึกเจ็บปวด",
      },
      {
        score: 2,
        label: "Very limited",
        shortTh: "ตอบสนองเฉพาะเมื่อเจ็บปวด",
        criterionTh:
          "ตอบสนองต่อการกระตุ้นที่ทำให้เจ็บปวดเท่านั้น ทำได้เพียงร้องครวญคราง หรือมีอาการกระสับกระส่าย หรือสูญเสียความสามารถในการรับความรู้สึกมากกว่า ½ ของร่างกาย",
      },
      {
        score: 3,
        label: "Slightly limited",
        shortTh: "ตอบสนองต่อคำพูด แต่บอกอาการไม่ได้ทุกครั้ง",
        criterionTh:
          "ตอบสนองต่อคำสั่งที่เป็นคำพูด แต่ไม่สามารถบอกได้ทุกครั้งเมื่อมีความรู้สึกไม่สุขสบาย หรือสูญเสียความสามารถในการรับความรู้สึกของแขนขา 1 หรือ 2 ข้าง",
      },
      {
        score: 4,
        label: "No impairment",
        shortTh: "รับรู้และสื่อสารได้ตามปกติ",
        criterionTh:
          "ตอบสนองต่อคำสั่งที่เป็นคำพูด หรือไม่มีความบกพร่องของประสาทรับความรู้สึก สามารถสื่อสารได้ด้วยความรู้สึกหรือคำพูด",
      },
    ],
  },
  {
    key: "moisture",
    labelTh: "ความเปียกชื้นของผิวหนัง",
    label: "Moisture",
    options: [
      {
        score: 1,
        label: "Constantly moist",
        shortTh: "เปียกชื้นเกือบตลอดเวลา",
        criterionTh:
          "ผิวหนังเปียกชื้นเกือบตลอดเวลา มีการตรวจพบทุกครั้งเมื่อเปลี่ยนท่า หรือพลิกตัวผู้ป่วย",
      },
      {
        score: 2,
        label: "Very moist",
        shortTh: "เปียกชื้นบ่อย",
        criterionTh:
          "ผิวหนังเปียกชื้นบ่อย แต่ไม่ใช่ตลอดเวลา เปลี่ยนผ้าปูที่นอน/เสื้อผ้าอย่างน้อยเวรละครั้ง",
      },
      {
        score: 3,
        label: "Occasionally moist",
        shortTh: "เปียกชื้นเป็นบางครั้ง",
        criterionTh:
          "ผิวหนังเปียกชื้นเป็นบางครั้ง ต้องได้รับการเปลี่ยนผ้าปูที่นอน/เสื้อผ้าเพิ่มประมาณวันละครั้ง",
      },
      {
        score: 4,
        label: "Rarely moist",
        shortTh: "ผิวหนังแห้งตามปกติ",
        criterionTh: "ผิวหนังแห้งปกติ เปลี่ยนผ้าปูที่นอน/เสื้อผ้าตามปกติ",
      },
    ],
  },
  {
    key: "activity",
    labelTh: "ความสามารถในการทำกิจกรรม",
    label: "Activity",
    options: [
      {
        score: 1,
        label: "Bedfast",
        shortTh: "นอนบนเตียงตลอดเวลา",
        criterionTh: "นอนอยู่กับเตียงตลอดเวลา",
      },
      {
        score: 2,
        label: "Chairfast",
        shortTh: "นั่งเก้าอี้หรือรถเข็น",
        criterionTh:
          "มีข้อจำกัดในการเดิน หรือไม่สามารถเดินได้ และ/หรือต้องช่วยเหลือเพื่อนั่งเก้าอี้หรือรถเข็น",
      },
      {
        score: 3,
        label: "Walks occasionally",
        shortTh: "เดินได้เป็นบางครั้ง",
        criterionTh:
          "สามารถเดินได้เองเป็นบางครั้ง แต่เป็นระยะทางสั้น ๆ อาจมีหรือไม่มีคนช่วย",
      },
      {
        score: 4,
        label: "Walks frequently",
        shortTh: "เดินได้เป็นประจำ",
        criterionTh:
          "เดินออกนอกห้องอย่างน้อย 2 ครั้งต่อวัน และเดินภายในห้องอย่างน้อยทุก 2 ชั่วโมง",
      },
    ],
  },
  {
    key: "mobility",
    labelTh: "ความสามารถในการเคลื่อนไหวร่างกาย",
    label: "Mobility",
    options: [
      {
        score: 1,
        label: "Completely immobile",
        shortTh: "ไม่สามารถเปลี่ยนท่าได้เอง",
        criterionTh: "ไม่สามารถขยับร่างกาย หรือแขนขาได้เอง ถ้าไม่ได้รับความช่วยเหลือ",
      },
      {
        score: 2,
        label: "Very limited",
        shortTh: "ขยับได้เล็กน้อยและไม่บ่อย",
        criterionTh:
          "สามารถขยับร่างกาย หรือแขนขาได้เพียงเล็กน้อยเป็นบางครั้ง ไม่สามารถทำได้บ่อย",
      },
      {
        score: 3,
        label: "Slightly limited",
        shortTh: "ขยับได้เล็กน้อยแต่บ่อย",
        criterionTh:
          "สามารถขยับร่างกาย หรือแขนขาได้เพียงเล็กน้อย แต่ทำได้บ่อย และทำได้อย่างอิสระ",
      },
      {
        score: 4,
        label: "No limitation",
        shortTh: "เปลี่ยนท่าได้เองตามปกติ",
        criterionTh: "สามารถเปลี่ยนท่าได้เอง และทำได้บ่อย โดยไม่ต้องการความช่วยเหลือ",
      },
    ],
  },
  {
    key: "nutrition",
    labelTh: "โภชนาการ",
    label: "Nutrition",
    options: [
      {
        score: 1,
        label: "Very poor",
        shortTh: "รับอาหารได้น้อยมาก หรือ NPO",
        criterionTh:
          "รับอาหารได้ ≤ 1/3 ของอาหารที่จัดให้ หรือ NPO หรือได้รับอาหารน้ำใส หรือได้ IV มากกว่า 5 วัน",
      },
      {
        score: 2,
        label: "Probably inadequate",
        shortTh: "รับอาหารได้ประมาณครึ่งหนึ่ง",
        criterionTh:
          "รับอาหารได้ ½ ของอาหารที่จัดให้ หรือได้รับอาหารเหลว หรือ feed น้อยกว่าที่ควรจะได้รับ",
      },
      {
        score: 3,
        label: "Adequate",
        shortTh: "รับอาหารได้มากกว่าครึ่ง",
        criterionTh:
          "รับอาหารได้มากกว่าครึ่งในแต่ละมื้อ หรือได้รับ feed หรือ TPN อย่างเพียงพอ",
      },
      {
        score: 4,
        label: "Excellent",
        shortTh: "รับอาหารได้เกือบหมดทุกมื้อ",
        criterionTh: "รับประทานอาหารได้เกือบหมดทุกมื้อ ไม่จำเป็นต้องให้อาหารเสริม",
      },
    ],
  },
  {
    key: "friction_and_shear",
    labelTh: "แรงเสียดสีและแรงไถล",
    label: "Friction & shear",
    options: [
      {
        score: 1,
        label: "Problem",
        shortTh: "มีปัญหามาก เลื่อนไถลหรือเสียดสีบ่อย",
        criterionTh:
          "ไม่สามารถยกผู้ป่วยขึ้นโดยไม่เสียดสีได้เลย เมื่ออยู่บนเตียงหรือนั่งเก้าอี้ ตัวมักจะเลื่อนไถลลง มีอาการเกร็ง กล้ามเนื้อหดตัวหรือสั่น ซึ่งทำให้มีการเสียดสีเกิดขึ้นเกือบตลอดเวลา",
      },
      {
        score: 2,
        label: "Potential problem",
        shortTh: "มีปัญหาบางส่วน ต้องช่วยเคลื่อนย้าย",
        criterionTh:
          "เคลื่อนไหวอย่างไม่มีแรง ระหว่างที่มีการเคลื่อนย้ายตัว อาจเกิดการเสียดสีของผิวหนังบ้าง สามารถทรงตัวได้ดีขณะอยู่บนเก้าอี้หรือบนเตียง แต่อาจมีเลื่อนไถลลงบ้างเป็นครั้งคราว",
      },
      {
        score: 3,
        label: "No apparent problem",
        shortTh: "ไม่มีปัญหาชัดเจน เคลื่อนไหวได้ดี",
        criterionTh:
          "เคลื่อนไหวร่างกายอย่างอิสระ และกล้ามเนื้อมีความแข็งแรงเพียงพอที่จะยกตัวในขณะเคลื่อนไหว สามารถทรงตัวได้เป็นอย่างดีเมื่ออยู่บนเตียงหรือบนเก้าอี้",
      },
    ],
  },
] as const;

/** English risk band for the band code stored with each assessment. */
export const BRADEN_RISK_LABELS: Record<string, string> = {
  VERY_HIGH: "Very high risk",
  HIGH: "High risk",
  MODERATE: "Moderate risk",
  MILD: "Mild risk",
  NO_CURRENT_RISK: "Not at risk on this form",
};

export const BRADEN_RISK_BANDS = [
  { range: "19–23", label: "ยังไม่จัดอยู่ในกลุ่มเสี่ยงตามเกณฑ์ในแบบฟอร์ม" },
  { range: "15–18", label: "เริ่มมีภาวะเสี่ยง" },
  { range: "13–14", label: "มีภาวะเสี่ยงปานกลาง" },
  { range: "10–12", label: "มีภาวะเสี่ยงสูง" },
  { range: "≤ 9", label: "มีภาวะเสี่ยงสูงมาก" },
] as const;

export function bradenRiskLabel(total: number) {
  if (total <= 9) return "มีภาวะเสี่ยงสูงมาก";
  if (total <= 12) return "มีภาวะเสี่ยงสูง";
  if (total <= 14) return "มีภาวะเสี่ยงปานกลาง";
  if (total <= 18) return "เริ่มมีภาวะเสี่ยง";
  return "ยังไม่จัดอยู่ในกลุ่มเสี่ยงตามเกณฑ์ในแบบฟอร์ม";
}
