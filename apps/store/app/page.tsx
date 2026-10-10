import Image from "next/image";
import Link from "next/link";
import { Card } from "@/components/arc/card/card";
import { config } from "../lib/config";

export const runtime = "nodejs";
// Config is read from env at request time, so a build without .env still succeeds.
export const dynamic = "force-dynamic";

const steps = [
  "The buyer taps the tag on a product they already own.",
  "Their agent pays $0.001 to confirm the tap with Res Labs and read the product.",
  "The agent asks the buyer, then pays for the reorder over MPP on Tempo testnet.",
];

export default function ProductPage() {
  return (
    <div className="product-layout">
      <div className="product-story">
        <div className="page-head">
          <h1>Orders here come only from agents</h1>
          <p className="lede">There is no buy button. A buyer&apos;s agent places each reorder.</p>
        </div>
        <section className="steps" aria-labelledby="steps-heading">
          <h2 id="steps-heading">How an order happens</h2>
          <ol className="step-list">
            {steps.map((step, index) => (
              <li key={step}>
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <Card
        className="product-card"
        title={`SKU ${config.demoSku}`}
        description="Sold to agents after a verified tap."
        media={
          <Image
            className="product-image"
            src="/product.svg"
            alt="Product vial"
            width={320}
            height={400}
            preload
          />
        }
        action={
          <Link className="primary-link" href="/orders">
            View paid orders
          </Link>
        }
      >
        <p className="price">
          <span className="price-value">{config.demoPrice}</span>
          <span className="price-unit">pathUSD</span>
        </p>
      </Card>
    </div>
  );
}
