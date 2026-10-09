import Image from "next/image";
import { config } from "../lib/config";

export const runtime = "nodejs";
// Config is read from env at request time, so a build without .env still succeeds.
export const dynamic = "force-dynamic";

export default function ProductPage() {
  return (
    <article className="product">
      <Image
        className="product-render"
        src="/product.svg"
        alt="Product vial"
        width={320}
        height={400}
      />
      <div className="product-info">
        <p className="sku">SKU {config.demoSku}</p>
        <p className="price">
          {config.demoPrice} <span className="unit">pathUSD</span>
        </p>
        <p className="lede">This store takes orders only from agents. There is no buy button.</p>
        <ol className="steps">
          <li>The buyer taps the tag on a product they already own.</li>
          <li>Their agent pays $0.001 to confirm the tap with Res Labs and read the product.</li>
          <li>The agent asks the buyer, then pays for the reorder over MPP on Tempo testnet.</li>
        </ol>
        <p className="note">
          Every paid order appears on the <a href="/orders">orders page</a> with its payer and
          transaction.
        </p>
      </div>
    </article>
  );
}
