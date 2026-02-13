import {
  validateAdapterUrl,
  type AgpAdapter,
  type BusinessProfile,
  type ExecuteOptions,
  type AdapterContext,
  defineManifest,
} from "agenr:adapter-api";

// -- Manifest ---------------------------------------------------------------

export const manifest = defineManifest({
  name: "Stripe",
  version: "1.2.0",
  description:
    "Accept payments, manage products, and process checkouts via Stripe.",
  auth: {
    type: "oauth2",
    strategy: "bearer",
    oauth: {
      oauthService: "stripe",
      authorizationUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      tokenContentType: "form",
      extraAuthParams: {
        response_type: "code",
        scope: "read_write",
      },
    },
  },
  authenticatedDomains: ["api.stripe.com"],
  allowedDomains: [],
});

// -- Adapter ----------------------------------------------------------------

export default class StripeAdapter implements AgpAdapter {
  private ctx: AdapterContext;

  constructor(_business: BusinessProfile, ctx: AdapterContext) {
    this.ctx = ctx;
  }

  // -- discover -------------------------------------------------------------

  async discover() {
    return {
      services: [
        {
          id: "products",
          name: "Products",
          description: "Query the product catalog with prices.",
        },
        {
          id: "checkout",
          name: "Checkout",
          description: "Create a checkout session for a product.",
          requiresConfirmation: true,
        },
      ],
    };
  }

  // -- query ----------------------------------------------------------------

  async query(params: { serviceId: string; options?: Record<string, unknown> }) {
    if (params.serviceId === "products") {
      return this.queryProducts();
    }

    return { results: [] };
  }

  private async queryProducts() {
    validateAdapterUrl("https://api.stripe.com/v1/products");

    const productsRes = await this.ctx.fetch(
      "https://api.stripe.com/v1/products?active=true&limit=100",
    );
    const productsData = (await productsRes.json()) as {
      data: Array<{
        id: string;
        name: string;
        description: string | null;
        active: boolean;
        default_price: string | null;
      }>;
    };

    const pricesRes = await this.ctx.fetch(
      "https://api.stripe.com/v1/prices?active=true&limit=100",
    );
    const pricesData = (await pricesRes.json()) as {
      data: Array<{
        id: string;
        unit_amount: number | null;
        currency: string;
        product: string;
      }>;
    };

    const priceMap = new Map<string, { amount: number; currency: string }>();
    for (const price of pricesData.data) {
      if (price.unit_amount !== null) {
        priceMap.set(price.product, {
          amount: price.unit_amount,
          currency: price.currency,
        });
      }
    }

    const results = productsData.data.map((product) => {
      const price = priceMap.get(product.id);
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        active: product.active,
        price: price
          ? {
              amount: price.amount,
              currency: price.currency,
              formatted: new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: price.currency,
              }).format(price.amount / 100),
            }
          : null,
      };
    });

    return { results };
  }

  // -- execute --------------------------------------------------------------

  async execute(params: Record<string, unknown>, _options: ExecuteOptions) {
    if (params.serviceId === "checkout") {
      return this.executeCheckout(params);
    }

    return { status: "error", message: "Unknown service: " + params.serviceId };
  }

  private async executeCheckout(params: Record<string, unknown>) {
    const productId = params.productId as string | undefined;
    if (!productId) {
      return { status: "error", message: "productId is required for checkout" };
    }

    validateAdapterUrl("https://api.stripe.com/v1/checkout/sessions");

    const body = new URLSearchParams({
      "line_items[0][price]": productId,
      "line_items[0][quantity]": "1",
      mode: "payment",
      success_url: "https://agenr.ai/checkout/success",
      cancel_url: "https://agenr.ai/checkout/cancel",
    });

    const res = await this.ctx.fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    );

    const session = (await res.json()) as { id: string; url: string };

    return {
      status: "success",
      data: {
        sessionId: session.id,
        checkoutUrl: session.url,
      },
    };
  }
}
