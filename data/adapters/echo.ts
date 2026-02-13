import {
  type AgpAdapter,
  type BusinessProfile,
  type ExecuteOptions,
  type AdapterContext,
  defineManifest,
} from "agenr:adapter-api";

const TAX_RATE = 0.0825;

const CATALOG = [
  { id: "echo-widget-1", name: "Widget", price: 9.99, currency: "USD" },
  { id: "echo-widget-2", name: "Gadget", price: 24.99, currency: "USD" },
  { id: "echo-sub-1", name: "Pro Plan", price: 49.99, currency: "USD", interval: "month" },
] as const;

const DEFAULT_ITEM = { productId: "echo-widget-1", name: "Widget", quantity: 1, price: 9.99 } as const;

type CatalogItem = (typeof CATALOG)[number];
type OrderItem = {
  productId: string;
  name: string;
  quantity: number;
  price: number;
};

export const manifest = defineManifest({
  name: "Echo",
  version: "1.0.0",
  description:
    "A test adapter for SDK experimentation. Returns deterministic fake data " +
    "so you can learn the AGP lifecycle without connecting a real service.",
  auth: { type: "none", strategy: "none" },
  authenticatedDomains: [],
  allowedDomains: [],
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function toQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return Math.floor(value);
}

function findCatalogItem(productId: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.id === productId);
}

function normalizeItems(request: Record<string, unknown>): { items: OrderItem[]; subtotal: number } {
  const rawItems = request["items"];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const fallbackTotal = asNumber(request["total"]);
    return {
      items: [{ ...DEFAULT_ITEM }],
      subtotal: toMoney(fallbackTotal ?? DEFAULT_ITEM.price),
    };
  }

  const normalizedItems = rawItems
    .map((rawItem) => asRecord(rawItem))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const productId = typeof item["productId"] === "string" ? item["productId"] : DEFAULT_ITEM.productId;
      const catalogItem = findCatalogItem(productId);
      const fallbackPrice = asNumber(item["price"]) ?? DEFAULT_ITEM.price;

      return {
        productId,
        name:
          catalogItem?.name ??
          (typeof item["name"] === "string" ? item["name"] : productId),
        quantity: toQuantity(item["quantity"]),
        price: catalogItem?.price ?? fallbackPrice,
      } satisfies OrderItem;
    });

  if (normalizedItems.length === 0) {
    return {
      items: [{ ...DEFAULT_ITEM }],
      subtotal: DEFAULT_ITEM.price,
    };
  }

  const subtotal = toMoney(
    normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
  );

  return {
    items: normalizedItems,
    subtotal,
  };
}

function buildSummary(params: Record<string, unknown>) {
  const request = asRecord(params["request"]) ?? params;
  const { items, subtotal } = normalizeItems(request);
  const tax = toMoney(subtotal * TAX_RATE);
  const total = toMoney(subtotal + tax);

  return {
    business: "Echo Labs",
    items,
    subtotal,
    tax,
    total,
    currency: "USD",
  };
}

export default class EchoAdapter implements AgpAdapter {
  constructor(_business: BusinessProfile, _ctx: AdapterContext) {}

  async discover() {
    return {
      business: {
        name: "Echo Labs",
        description: "A test business for SDK experimentation.",
      },
      services: [
        {
          id: "catalog",
          name: "Product Catalog",
          description: "Browse test products.",
        },
        {
          id: "order",
          name: "Place Order",
          description: "Simulate a purchase transaction.",
          requiresConfirmation: true,
        },
        {
          id: "ping",
          name: "Ping",
          description: "Echo back any payload. Useful for testing request shapes.",
        },
      ],
      hints: {
        typicalFlow:
          "query catalog -> pick products -> execute order -> user approves confirmation -> execute with token",
        queryParams: {
          catalog: { serviceId: "catalog" },
          ping: { serviceId: "ping", options: { any: "value" } },
        },
        executeParams: {
          order: {
            serviceId: "order",
            items: [{ productId: "echo-widget-1", quantity: 1 }],
          },
        },
        confirmationFlow:
          "Execute returns pending_confirmation with a confirmationToken and summary. Present the summary to the user. After approval, call execute again with the confirmationToken to complete.",
        simulationModes: {
          failure: "Pass simulate: 'failure' in execute to test error handling",
          expired: "Pass simulate: 'expired' to test expired confirmation tokens",
        },
      },
    };
  }

  async query(params: { serviceId?: string; options?: Record<string, unknown> }) {
    if (params.serviceId === "catalog") {
      return { results: CATALOG };
    }

    if (params.serviceId === "ping") {
      return { echo: params.options };
    }

    return { results: [] };
  }

  async execute(params: Record<string, unknown>, _options: ExecuteOptions) {
    const request = asRecord(params["request"]) ?? params;
    const simulate = request["simulate"];
    if (simulate === "failure") {
      return { status: "failed", error: "Simulated failure for testing" };
    }

    if (simulate === "expired") {
      return { status: "failed", error: "Confirmation token expired. Please start a new order." };
    }

    const confirmationToken =
      typeof request["confirmationToken"] === "string" ? request["confirmationToken"] : undefined;
    const summary = buildSummary(params);

    if (!confirmationToken) {
      return {
        status: "pending_confirmation",
        confirmationToken: "echo-confirm-" + Date.now(),
        summary,
        message: "Please confirm this order. Pass the confirmationToken back to execute to complete.",
        expiresIn: "5 minutes",
      };
    }

    if (!confirmationToken.startsWith("echo-confirm-")) {
      return {
        status: "failed",
        error: "Invalid confirmation token",
      };
    }

    return {
      status: "completed",
      orderId: "echo-order-" + Date.now(),
      confirmationToken,
      receipt: {
        ...summary,
        paidAt: new Date().toISOString(),
      },
      message: "Order completed successfully. This is a simulated transaction.",
    };
  }
}
