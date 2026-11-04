import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Camera, CheckCircle2, FlaskConical, Frame, Ruler, Upload } from "lucide-react";

import { SamplePhotos } from "@/components/demo/SamplePhotos";
import { DEMO_MODE } from "@/lib/accounts";

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
        <section className="panel" aria-labelledby="samples-title">
          <h2 id="samples-title" className="section-title">Try it with a sample photo</h2>
          <p className="muted-text">
            No printed ruler yet? These three photos already include the WoundMeter ruler and show one wound healing over time:
            A (open), B (small) and C (healed, which WoundMeter reports as &ldquo;No visible wound detected&rdquo;). Download one and upload it
            {DEMO_MODE ? " in the demo, or use it straight from the demo page." : " where you measure a wound."}
          </p>
          <SamplePhotos />
          {DEMO_MODE && (
            <div className="button-row">
              <Link href="/demo" className="button primary"><FlaskConical aria-hidden="true" /> Open the demo (no sign-in)</Link>
              <Link href="/" className="button secondary">Sign in with a demo account</Link>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
