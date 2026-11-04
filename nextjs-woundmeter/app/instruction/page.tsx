import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Camera, CheckCircle2, Frame, Ruler, Upload } from "lucide-react";

export const metadata = { title: "Photo guide" };

const steps = [
  {
    title: "Place the manufactured ruler",
    description: "Place the approved L-ruler beside the wound, with both on approximately the same plane.",
    image: "/images/instruction_1ruler.png",
    icon: Ruler,
  },
  {
    title: "Frame the corner and length tags",
    description: "Keep IDs 1, 0, and 10 plus the fourth size-ID tag visible. Its decimal ID is the complete ruler size in centimetres.",
    image: "/images/instruction_2takephoto.png",
    icon: Frame,
  },
  {
    title: "Take one complete photograph",
    description: "Use the standard camera, avoid glare and deep shadow, and do not crop or resize the photograph.",
    image: "/images/instruction_3woundwithruler.png",
    icon: Camera,
  },
  {
    title: "Upload the original image",
    description: "The app checks the file, then the server finds the ruler, corrects for camera tilt and outlines the wound.",
    icon: Upload,
  },
  {
    title: "Review the calibrated result",
    description: "Check the straightened photo, the wound outline, any warnings and the measurements. A clinician reviews every result before it joins the record.",
    icon: CheckCircle2,
  },
];

export default function InstructionPage() {
  return (
    <main className="guide" id="main">
      <div className="page page-wide">
        <Link href="/" className="link-button back-link">
          <ArrowLeft aria-hidden="true" />
          Back to WoundMeter
        </Link>
        <header className="page-header">
          <h1>Photo guide</h1>
          <p>Photograph the whole ruler and never crop the photo. The pictures show placement only; they are not a printable template.</p>
        </header>
        <ol className="guide-steps">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="panel">
                <div className="guide-step-head">
                  <span className="guide-step-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <div>
                    <p className="fine-print">Step {index + 1}</p>
                    <h2 className="section-title">{step.title}</h2>
                  </div>
                </div>
                <p className="muted-text">{step.description}</p>
                {step.image && <div className="guide-image">
                  <Image src={step.image} alt="" fill className="object-contain" />
                </div>}
              </li>
            );
          })}
        </ol>
      </div>
    </main>
  );
}
