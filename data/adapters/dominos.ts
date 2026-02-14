import {
  type AgpAdapter,
  type BusinessProfile,
  type ExecuteOptions,
  type AdapterContext,
  defineManifest,
} from "agenr:adapter-api";

// -- Manifest ---------------------------------------------------------------

export const manifest = defineManifest({
  name: "Dominos",
  version: "1.0.0",
  description:
    "Order pizza from Domino's. Find nearby stores, browse menus, place delivery or carryout orders, and track them in real time.",
  auth: { type: "none", strategy: "none" },
  authenticatedDomains: [],
  allowedDomains: [
    "order.dominos.com",
    "tracker.dominos.com",
  ],
});

// -- Types ------------------------------------------------------------------

interface StoreResult {
  storeId: string;
  name: string;
  phone: string;
  address: string;
  isOpen: boolean;
  serviceIsOpen: Record<string, unknown>;
  estimatedWaitMinutes: Record<string, unknown>;
  distance: string;
}

interface MenuItem {
  code: string;
  name: string;
  description?: string;
  price?: string;
  sizeCode?: string;
}

interface MenuCategory {
  category: string;
  items: MenuItem[];
}

interface OrderProduct {
  Code: string;
  Qty: number;
  Options?: Record<string, unknown>;
}

interface PaymentCash {
  Type: "Cash";
}

interface PaymentCard {
  Type: "CreditCard";
  Amount: number;
  Number: string;
  Expiration: string;
  SecurityCode: string;
  PostalCode: string;
}

type Payment = PaymentCash | PaymentCard;

interface OrderParams {
  serviceMethod?: "Delivery" | "Carryout";
  storeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  addressType?: string;
  products: OrderProduct[];
  payment?: "Cash" | { type: "CreditCard"; number: string; expiration: string; securityCode: string; postalCode: string };
  coupons?: string[];
  confirmationToken?: string;
}

// -- Helpers ----------------------------------------------------------------

const BASE = "https://order.dominos.com/power";
const TRACKER = "https://tracker.dominos.com/tracker-presentation-service/v2";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: "https://order.dominos.com/en/pages/order/",
      ...rec(init?.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Domino's API error ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

function buildOrderPayload(p: OrderParams) {
  const payments: Payment[] = [];
  if (!p.payment || p.payment === "Cash") {
    payments.push({ Type: "Cash" });
  } else {
    payments.push({
      Type: "CreditCard",
      Amount: 0, // filled after pricing
      Number: p.payment.number,
      Expiration: p.payment.expiration,
      SecurityCode: p.payment.securityCode,
      PostalCode: p.payment.postalCode,
    });
  }

  return {
    Order: {
      Address: {
        Street: p.street,
        City: p.city,
        Region: p.region,
        PostalCode: p.postalCode,
        Type: p.addressType || "House",
      },
      Coupons: (p.coupons || []).map((c) => ({ Code: c, Qty: 1 })),
      CustomerID: "",
      Extension: "",
      OrderChannel: "OLO",
      OrderMethod: "Web",
      LanguageCode: "en",
      ServiceMethod: p.serviceMethod || "Delivery",
      SourceOrganizationURI: "order.dominos.com",
      StoreID: p.storeId,
      Tags: {},
      Version: "1.0",
      NoCombine: true,
      Partners: {},
      NewUser: true,
      metaData: { prop65Warning: {} },
      Products: p.products,
      Payments: payments,
      FirstName: p.firstName,
      LastName: p.lastName,
      Email: p.email,
      Phone: p.phone,
    },
  };
}

function extractOrderParams(params: Record<string, unknown>): OrderParams {
  const r = rec(params.request) || params;
  const products = arr(r.products).map((item) => {
    const p = rec(item);
    return {
      Code: str(p.Code || p.code),
      Qty: num(p.Qty || p.qty) ?? 1,
      Options: rec(p.Options || p.options),
    };
  });

  if (products.length === 0) {
    throw new Error("At least one product is required. Use the menu service to find product codes.");
  }

  let payment: OrderParams["payment"] = "Cash";
  const rawPayment = r.payment;
  if (rawPayment && typeof rawPayment === "object" && !Array.isArray(rawPayment)) {
    const pm = rec(rawPayment);
    if (str(pm.type) === "CreditCard") {
      payment = {
        type: "CreditCard",
        number: str(pm.number),
        expiration: str(pm.expiration),
        securityCode: str(pm.securityCode),
        postalCode: str(pm.postalCode),
      };
    }
  }

  return {
    serviceMethod: (str(r.serviceMethod) as "Delivery" | "Carryout") || "Delivery",
    storeId: str(r.storeId),
    firstName: str(r.firstName),
    lastName: str(r.lastName),
    email: str(r.email),
    phone: str(r.phone),
    street: str(r.street),
    city: str(r.city),
    region: str(r.region),
    postalCode: str(r.postalCode),
    addressType: str(r.addressType) || "House",
    products,
    payment,
    coupons: arr(r.coupons).map((c) => str(c)).filter(Boolean),
    confirmationToken: str(r.confirmationToken) || undefined,
  };
}

// -- Menu parsing -----------------------------------------------------------

function flattenCategories(node: unknown): Array<{ name: string; products: string[] }> {
  const n = rec(node);
  const results: Array<{ name: string; products: string[] }> = [];
  const name = str(n.Name);
  const prods = arr(n.Products).map((p) => str(p)).filter(Boolean);
  if (name && prods.length > 0) {
    results.push({ name, products: prods });
  }
  for (const child of arr(n.Categories)) {
    results.push(...flattenCategories(child));
  }
  return results;
}

function parseMenu(data: unknown): { categories: MenuCategory[]; popular: MenuItem[] } {
  const root = rec(data);
  const variants = rec(root.Variants);
  const products = rec(root.Products);
  const preconfigured = rec(root.PreconfiguredProducts);

  // Build a variant lookup: code → { name, price, sizeCode }
  const variantMap = new Map<string, MenuItem>();
  for (const [code, v] of Object.entries(variants)) {
    const vr = rec(v);
    variantMap.set(code, {
      code,
      name: str(vr.Name),
      price: str(vr.Price),
      sizeCode: str(vr.SizeCode),
    });
  }

  // Preconfigured products are the recognizable menu items
  const popular: MenuItem[] = [];
  for (const [code, p] of Object.entries(preconfigured)) {
    const pr = rec(p);
    const name = str(pr.Name) || str(pr.name);
    const desc = str(pr.Description) || str(pr.description);
    if (!name) continue;
    popular.push({
      code,
      name,
      description: desc || undefined,
      price: str(pr.Price) || undefined,
    });
  }

  // Walk Categorization.Food.Categories (nested tree) to build category groups
  const categorization = rec(root.Categorization);
  const foodNode = rec(categorization.Food);
  const flatCats = flattenCategories(foodNode);

  const categoryGroups = new Map<string, MenuItem[]>();
  for (const { name: catName, products: productCodes } of flatCats) {
    const items: MenuItem[] = [];
    for (const prodCode of productCodes) {
      const prod = rec(products[prodCode]);
      if (!prod || !str(prod.Name)) continue;

      // Get representative variants for this product
      const prodVariants = arr(prod.Variants);
      const representative = prodVariants.slice(0, 3).map((vc) => {
        return variantMap.get(str(vc)) ?? null;
      }).filter(Boolean) as MenuItem[];

      if (representative.length > 0) {
        items.push(...representative);
      } else {
        items.push({
          code: prodCode,
          name: str(prod.Name),
          description: str(prod.Description) || undefined,
        });
      }
    }

    if (items.length > 0) {
      const existing = categoryGroups.get(catName) || [];
      existing.push(...items);
      categoryGroups.set(catName, existing);
    }
  }

  // Limit each category to avoid massive responses
  const categories: MenuCategory[] = [];
  for (const [category, items] of categoryGroups) {
    categories.push({
      category,
      items: items.slice(0, 15),
    });
  }

  return { categories: categories.slice(0, 20), popular: popular.slice(0, 30) };
}

// -- Adapter ----------------------------------------------------------------

export default class DominosAdapter implements AgpAdapter {
  constructor(_business: BusinessProfile, _ctx: AdapterContext) {}

  // -- discover -------------------------------------------------------------

  async discover() {
    return {
      business: {
        name: "Domino's Pizza",
        description:
          "Order pizza, pasta, sandwiches, and more from Domino's for delivery or carryout.",
      },
      services: [
        {
          id: "find_stores",
          name: "Find Nearby Stores",
          description:
            "Find Domino's stores near an address. Returns store IDs, hours, distance, and estimated wait times.",
        },
        {
          id: "menu",
          name: "Store Menu",
          description:
            "Get the menu for a specific store. Returns popular items and categories with product codes needed for ordering.",
        },
        {
          id: "order",
          name: "Place Order",
          description:
            "Place a delivery or carryout order. First call prices the order and returns a confirmation summary. " +
            "Second call with the confirmationToken places the order.",
          requiresConfirmation: true,
        },
        {
          id: "track",
          name: "Track Order",
          description:
            "Track an order by store ID and phone number.",
        },
      ],
      hints: {
        typicalFlow:
          "1. find_stores (get storeId) → 2. menu (browse items, get product codes) → 3. order (prices it, returns confirmation) → 4. order with confirmationToken (places it) → 5. track",
        queryParams: {
          find_stores: {
            serviceId: "find_stores",
            options: {
              street: "1600 Pennsylvania Ave",
              city: "Washington, DC 20500",
              type: "Delivery",
            },
          },
          menu: {
            serviceId: "menu",
            options: { storeId: "4336" },
          },
          track: {
            serviceId: "track",
            options: { storeId: "4336", phone: "2025551234" },
          },
        },
        executeParams: {
          order: {
            serviceId: "order",
            storeId: "4336",
            serviceMethod: "Delivery",
            firstName: "John",
            lastName: "Doe",
            email: "john@example.com",
            phone: "2025551234",
            street: "1600 Pennsylvania Ave",
            city: "Washington",
            region: "DC",
            postalCode: "20500",
            products: [{ Code: "14SCREEN", Qty: 1 }],
            payment: "Cash",
          },
        },
        confirmationFlow:
          "The first execute call validates and prices the order, returning pending_confirmation with a confirmationToken and price breakdown. " +
          "Present the summary (items, subtotal, tax, total, estimated wait) to the user. " +
          "After approval, call execute again with the same params plus confirmationToken to place the order.",
        productCodes:
          "Product codes come from the menu service. Common ones: 14SCREEN (large hand-tossed cheese), " +
          "P_14SCREEN (large pepperoni), S_14SCREEN (large sausage), 14THIN (large thin crust cheese), " +
          "P12IPAZA (medium pan pepperoni). Use the menu to find exact codes for the store.",
        paymentTypes: {
          cash: '"payment": "Cash"',
          creditCard:
            '"payment": { "type": "CreditCard", "number": "...", "expiration": "0135", "securityCode": "123", "postalCode": "20500" }',
        },
      },
    };
  }

  // -- query ----------------------------------------------------------------

  async query(params: Record<string, unknown>) {
    const serviceId = str(params.serviceId);
    const options = rec(params.options);

    switch (serviceId) {
      case "find_stores":
        return this.queryStores(options);
      case "menu":
        return this.queryMenu(options);
      case "track":
        return this.queryTrack(options);
      default:
        return { error: `Unknown service: ${serviceId}. Available: find_stores, menu, track` };
    }
  }

  private async queryStores(options: Record<string, unknown>) {
    const street = str(options.street);
    const city = str(options.city);
    const type = str(options.type) || "Delivery";

    if (!street && !city) {
      return { error: "Provide at least 'street' or 'city' to find stores." };
    }

    const url =
      `${BASE}/store-locator?s=${encodeURIComponent(street)}&c=${encodeURIComponent(city)}&type=${encodeURIComponent(type)}`;
    const data = rec(await fetchJson(url));
    const stores = arr(data.Stores);

    const results: StoreResult[] = stores.slice(0, 10).map((s) => {
      const store = rec(s);
      const addr = rec(store.Address);
      const serviceIsOpen = rec(store.ServiceIsOpen);
      return {
        storeId: str(store.StoreID),
        name: str(store.StoreName) || `Store #${str(store.StoreID)}`,
        phone: str(store.Phone),
        address: [str(addr.Street), str(addr.City), str(addr.Region), str(addr.PostalCode)]
          .filter(Boolean)
          .join(", "),
        isOpen: store.IsOpen === true,
        serviceIsOpen: serviceIsOpen,
        estimatedWaitMinutes: rec(store.ServiceMethodEstimatedWaitMinutes),
        distance: str(store.MinDistance),
      };
    });

    return {
      type,
      storeCount: results.length,
      stores: results,
      hint: "Use a storeId to query the menu or place an order.",
    };
  }

  private async queryMenu(options: Record<string, unknown>) {
    const storeId = str(options.storeId);
    if (!storeId) {
      return { error: "storeId is required. Use find_stores to get one." };
    }

    const url = `${BASE}/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`;
    const data = await fetchJson(url);
    const { categories, popular } = parseMenu(data);

    return {
      storeId,
      popularItems: popular,
      categories,
      hint: "Use product 'code' values in the order's products array. Example: { Code: '14SCREEN', Qty: 1 }",
    };
  }

  private async queryTrack(options: Record<string, unknown>) {
    const storeId = str(options.storeId);
    const phone = str(options.phone);

    if (!storeId || !phone) {
      return { error: "Both storeId and phone are required to track an order." };
    }

    const url = `${TRACKER}/orders?storeId=${encodeURIComponent(storeId)}&phoneNumber=${encodeURIComponent(phone)}`;
    const data = await fetchJson(url);
    return { tracking: data };
  }

  // -- execute --------------------------------------------------------------

  async execute(params: Record<string, unknown>, _options: ExecuteOptions | undefined) {
    const serviceId = str(params.serviceId);
    if (serviceId !== "order") {
      return { status: "failed", error: `Only the 'order' service supports execute. Got: ${serviceId}` };
    }

    try {
      return await this.executeOrder(params);
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeOrder(params: Record<string, unknown>) {
    const orderParams = extractOrderParams(params);

    // Validate required fields
    const missing = (["storeId", "firstName", "lastName", "phone", "street", "city", "region", "postalCode"] as const)
      .filter((f) => !orderParams[f]);
    if (missing.length > 0) {
      return { status: "failed", error: `Missing required fields: ${missing.join(", ")}` };
    }

    const payload = buildOrderPayload(orderParams);

    // If no confirmation token → validate + price, return summary
    if (!orderParams.confirmationToken) {
      // Validate the order
      const validated = rec(await fetchJson(`${BASE}/validate-order`, {
        method: "POST",
        body: JSON.stringify(payload),
      }));

      const validatedOrder = rec(validated.Order);
      const status = rec(validatedOrder.Status);
      const statusCode = num(status.StatusCode);

      if (statusCode === -1) {
        const statusItems = arr(status.StatusItems);
        return {
          status: "failed",
          error: "Order validation failed",
          details: statusItems.map((i) => str(rec(i).PulseText)).filter(Boolean),
        };
      }

      const statusItems = arr(status.StatusItems);
      const errors = statusItems.filter((si) => {
        const item = rec(si);
        return str(item.Code) !== "" && rec(item).IsError === true;
      });

      if (errors.length > 0) {
        return {
          status: "failed",
          error: "Order validation failed",
          details: errors.map((e) => str(rec(e).PulseText)),
        };
      }

      // Price the order
      const priced = rec(await fetchJson(`${BASE}/price-order`, {
        method: "POST",
        body: JSON.stringify(payload),
      }));

      const pricedOrder = rec(priced.Order);
      const amounts = rec(pricedOrder.Amounts);
      const estimatedWait = rec(pricedOrder.EstimatedWaitMinutes);

      // If credit card, set the amount
      if (orderParams.payment !== "Cash" && payload.Order.Payments[0]?.Type === "CreditCard") {
        (payload.Order.Payments[0] as PaymentCard).Amount =
          Number(amounts.Payment) || Number(amounts.Customer) || 0;
      }

      const token = `dominos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Store the priced payload in the token (base64-encode it)
      const pricedPayloadB64 = btoa(JSON.stringify(payload));

      return {
        status: "pending_confirmation",
        confirmationToken: `${token}:${pricedPayloadB64}`,
        summary: {
          storeId: orderParams.storeId,
          serviceMethod: orderParams.serviceMethod,
          deliveryAddress: `${orderParams.street}, ${orderParams.city}, ${orderParams.region} ${orderParams.postalCode}`,
          customer: `${orderParams.firstName} ${orderParams.lastName}`,
          products: orderParams.products.map((p) => ({ code: p.Code, qty: p.Qty })),
          subtotal: amounts.Menu,
          discount: amounts.Discount,
          surcharge: amounts.Surcharge,
          tax: amounts.Tax,
          total: amounts.Customer || amounts.Payment,
          estimatedWaitMinutes: estimatedWait,
          payment: orderParams.payment === "Cash" ? "Cash" : "Credit Card",
        },
        message:
          "Review the order summary above. To confirm, call execute again with the same params and include the confirmationToken.",
        expiresIn: "15 minutes",
      };
    }

    // Confirmation token present → place the order
    const tokenParts = orderParams.confirmationToken.split(":");
    if (tokenParts.length < 2 || !tokenParts[0]?.startsWith("dominos-")) {
      return { status: "failed", error: "Invalid confirmation token." };
    }

    let finalPayload: any;
    try {
      finalPayload = JSON.parse(atob(tokenParts.slice(1).join(":")));
    } catch {
      return { status: "failed", error: "Corrupted confirmation token. Please start a new order." };
    }

    const result = rec(await fetchJson(`${BASE}/place-order`, {
      method: "POST",
      body: JSON.stringify(finalPayload),
    }));

    const resultOrder = rec(result.Order);
    const resultStatus = rec(resultOrder.Status);

    // Check for placement errors
    if (num(resultStatus.StatusCode) === -1) {
      const items = arr(resultStatus.StatusItems);
      return {
        status: "failed",
        error: "Order placement failed",
        details: items.map((i) => str(rec(i).PulseText)).filter(Boolean),
      };
    }

    return {
      status: "completed",
      orderId: str(resultOrder.OrderID),
      storeId: str(resultOrder.StoreID),
      estimatedWaitMinutes: rec(resultOrder.EstimatedWaitMinutes),
      total: rec(resultOrder.Amounts).Customer || rec(resultOrder.Amounts).Payment,
      message: "Order placed successfully! Use the track service to follow your order.",
      trackingHint: {
        serviceId: "track",
        storeId: str(resultOrder.StoreID),
        phone: str(resultOrder.Phone),
      },
    };
  }
}
