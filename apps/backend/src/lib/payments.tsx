import { PrismaClientTransaction } from "@/prisma-client";
import { PurchaseCreationSource, SubscriptionStatus } from "@prisma/client";
import { KnownErrors } from "@stackframe/stack-shared";
import type { inlineProductSchema, productSchema } from "@stackframe/stack-shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES } from "@stackframe/stack-shared/dist/utils/currency-constants";
import { FAR_FUTURE_DATE, addInterval, getIntervalsElapsed } from "@stackframe/stack-shared/dist/utils/dates";
import { StackAssertionError, StatusError, throwErr } from "@stackframe/stack-shared/dist/utils/errors";
import { filterUndefined, getOrUndefined, has, typedEntries, typedFromEntries, typedKeys, typedValues } from "@stackframe/stack-shared/dist/utils/objects";
import { typedToUppercase } from "@stackframe/stack-shared/dist/utils/strings";
import { isUuid } from "@stackframe/stack-shared/dist/utils/uuids";
import Stripe from "stripe";
import * as yup from "yup";
import { Tenancy } from "./tenancies";
import { getStripeForAccount } from "./stripe";

const DEFAULT_PRODUCT_START_DATE = new Date("1973-01-01T12:00:00.000Z"); // monday

type Product = yup.InferType<typeof productSchema>;
type SelectedPrice = Exclude<Product["prices"], "include-by-default">[string];

export async function ensureProductIdOrInlineProduct(
  tenancy: Tenancy,
  accessType: "client" | "server" | "admin",
  productId: string | undefined,
  inlineProduct: yup.InferType<typeof inlineProductSchema> | undefined
): Promise<Tenancy["config"]["payments"]["products"][string]> {
  if (productId && inlineProduct) {
    throw new StatusError(400, "Cannot specify both product_id and product_inline!");
  }
  if (inlineProduct && accessType === "client") {
    throw new StatusError(400, "Cannot specify product_inline when calling from client! Please call with a server API key, or use the product_id parameter.");
  }
  if (!productId && !inlineProduct) {
    throw new StatusError(400, "Must specify either product_id or product_inline!");
  }
  if (productId) {
    const product = getOrUndefined(tenancy.config.payments.products, productId);
    if (!product) {
      const itemExists = has(tenancy.config.payments.items, productId);
      throw new KnownErrors.ProductDoesNotExist(productId, itemExists ? "item_exists" : null);
    }
    if (product.serverOnly && accessType === "client") {
      throw new KnownErrors.ProductDoesNotExist(productId, "server_only");
    }
    return product;
  } else {
    if (!inlineProduct) {
      throw new StackAssertionError("Inline product does not exist, this should never happen", { inlineProduct, productId });
    }
    return {
      catalogId: undefined,
      isAddOnTo: false,
      displayName: inlineProduct.display_name,
      customerType: inlineProduct.customer_type,
      freeTrial: inlineProduct.free_trial,
      serverOnly: inlineProduct.server_only,
      stackable: false,
      prices: Object.fromEntries(Object.entries(inlineProduct.prices).map(([key, value]) => [key, {
        ...typedFromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, getOrUndefined(value, c.code)])),
        interval: value.interval,
        freeTrial: value.free_trial,
        serverOnly: true,
      }])),
      includedItems: typedFromEntries(Object.entries(inlineProduct.included_items).map(([key, value]) => [key, {
        repeat: value.repeat ?? "never",
        quantity: value.quantity ?? 0,
        expires: value.expires ?? "never",
      }])),
    };
  }
}

type LedgerTransaction = {
  amount: number,
  grantTime: Date,
  expirationTime: Date,
};


function computeLedgerBalanceAtNow(transactions: LedgerTransaction[], now: Date): number {
  const grantedAt = new Map<number, number>();
  const expiredAt = new Map<number, number>();
  const usedAt = new Map<number, number>();
  const timeSet = new Set<number>();

  for (const t of transactions) {
    const grantTime = t.grantTime.getTime();
    if (t.grantTime <= now && t.amount < 0 && t.expirationTime > now) {
      usedAt.set(grantTime, (-1 * t.amount) + (usedAt.get(grantTime) ?? 0));
    }
    if (t.grantTime <= now && t.amount > 0) {
      grantedAt.set(grantTime, (grantedAt.get(grantTime) ?? 0) + t.amount);
    }
    if (t.expirationTime <= now && t.amount > 0) {
      const time2 = t.expirationTime.getTime();
      expiredAt.set(time2, (expiredAt.get(time2) ?? 0) + t.amount);
      timeSet.add(time2);
    }
    timeSet.add(grantTime);
  }
  const times = Array.from(timeSet.values()).sort((a, b) => a - b);
  if (times.length === 0) {
    return 0;
  }

  let grantedSum = 0;
  let expiredSum = 0;
  let usedSum = 0;
  let usedOrExpiredSum = 0;
  for (const t of times) {
    const g = grantedAt.get(t) ?? 0;
    const e = expiredAt.get(t) ?? 0;
    const u = usedAt.get(t) ?? 0;
    grantedSum += g;
    expiredSum += e;
    usedSum += u;
    usedOrExpiredSum = Math.max(usedOrExpiredSum + u, expiredSum);
  }
  return grantedSum - usedOrExpiredSum;
}

function addWhenRepeatedItemWindowTransactions(options: {
  baseQty: number,
  repeat: [number, 'day' | 'week' | 'month' | 'year'],
  anchor: Date,
  nowClamped: Date,
  hardEnd: Date | null,
}): LedgerTransaction[] {
  const { baseQty, repeat, anchor, nowClamped } = options;
  const endLimit = options.hardEnd ?? FAR_FUTURE_DATE;
  const finalNow = nowClamped < endLimit ? nowClamped : endLimit;
  if (finalNow < anchor) return [];

  const entries: LedgerTransaction[] = [];
  const elapsed = getIntervalsElapsed(anchor, finalNow, repeat);

  for (let i = 0; i <= elapsed; i++) {
    const windowStart = addInterval(new Date(anchor), [repeat[0] * i, repeat[1]]);
    const windowEnd = addInterval(new Date(windowStart), repeat);
    entries.push({ amount: baseQty, grantTime: windowStart, expirationTime: windowEnd });
  }

  return entries;
}

export async function getItemQuantityForCustomer(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  itemId: string,
  customerId: string,
  customerType: "user" | "team" | "custom",
}) {
  const now = new Date();
  const transactions: LedgerTransaction[] = [];

  // Quantity changes → ledger entries
  const changes = await options.prisma.itemQuantityChange.findMany({
    where: {
      tenancyId: options.tenancy.id,
      customerId: options.customerId,
      itemId: options.itemId,
    },
    orderBy: { createdAt: "asc" },
  });
  for (const c of changes) {
    transactions.push({
      amount: c.quantity,
      grantTime: c.createdAt,
      expirationTime: c.expiresAt ?? FAR_FUTURE_DATE,
    });
  }
  const oneTimePurchases = await options.prisma.oneTimePurchase.findMany({
    where: {
      tenancyId: options.tenancy.id,
      customerId: options.customerId,
      customerType: typedToUppercase(options.customerType),
    },
  });
  for (const p of oneTimePurchases) {
    const product = p.product as yup.InferType<typeof productSchema>;
    const inc = getOrUndefined(product.includedItems, options.itemId);
    if (!inc) continue;
    const baseQty = inc.quantity * p.quantity;
    if (baseQty <= 0) continue;
    transactions.push({
      amount: baseQty,
      grantTime: p.createdAt,
      expirationTime: FAR_FUTURE_DATE,
    });
  }

  // Subscriptions → ledger entries
  const subscriptions = await getSubscriptions({
    prisma: options.prisma,
    tenancy: options.tenancy,
    customerType: options.customerType,
    customerId: options.customerId,
  });
  for (const s of subscriptions) {
    const product = s.product;
    const inc = getOrUndefined(product.includedItems, options.itemId);
    if (!inc) continue;
    const baseQty = inc.quantity * s.quantity;
    if (baseQty <= 0) continue;
    const pStart = s.currentPeriodStart;
    const pEnd = s.currentPeriodEnd ?? FAR_FUTURE_DATE;
    const nowClamped = now < pEnd ? now : pEnd;
    if (nowClamped < pStart) continue;

    if (!inc.repeat || inc.repeat === "never") {
      if (inc.expires === "when-purchase-expires") {
        transactions.push({ amount: baseQty, grantTime: pStart, expirationTime: pEnd });
      } else if (inc.expires === "when-repeated") {
        // repeat=never + expires=when-repeated → treat as no expiry
        transactions.push({ amount: baseQty, grantTime: pStart, expirationTime: FAR_FUTURE_DATE });
      } else {
        transactions.push({ amount: baseQty, grantTime: pStart, expirationTime: FAR_FUTURE_DATE });
      }
    } else {
      const repeat = inc.repeat;
      if (inc.expires === "when-purchase-expires") {
        const elapsed = getIntervalsElapsed(pStart, nowClamped, repeat);
        const occurrences = elapsed + 1;
        const amount = occurrences * baseQty;
        transactions.push({ amount, grantTime: pStart, expirationTime: pEnd });
      } else if (inc.expires === "when-repeated") {
        const entries = addWhenRepeatedItemWindowTransactions({
          baseQty,
          repeat,
          anchor: s.createdAt,
          nowClamped,
          hardEnd: s.currentPeriodEnd,
        });
        transactions.push(...entries);
      } else {
        const elapsed = getIntervalsElapsed(pStart, nowClamped, repeat);
        const occurrences = elapsed + 1;
        const amount = occurrences * baseQty;
        transactions.push({ amount, grantTime: pStart, expirationTime: FAR_FUTURE_DATE });
      }
    }
  }

  return computeLedgerBalanceAtNow(transactions, now);
}

type Subscription = {
  /**
   * `null` for default subscriptions
   */
  id: string | null,
  /**
   * `null` for inline products
   */
  productId: string | null,
  /**
   * `null` for test mode purchases and catalog default products
   */
  stripeSubscriptionId: string | null,
  product: yup.InferType<typeof productSchema>,
  quantity: number,
  currentPeriodStart: Date,
  currentPeriodEnd: Date | null,
  status: SubscriptionStatus,
  createdAt: Date,
};

export function isActiveSubscription(subscription: Subscription): boolean {
  return subscription.status === SubscriptionStatus.active || subscription.status === SubscriptionStatus.trialing;
}

export async function getSubscriptions(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  customerType: "user" | "team" | "custom",
  customerId: string,
}) {
  const catalogs = options.tenancy.config.payments.catalogs;
  const products = options.tenancy.config.payments.products;
  const subscriptions: Subscription[] = [];
  const dbSubscriptions = await options.prisma.subscription.findMany({
    where: {
      tenancyId: options.tenancy.id,
      customerType: typedToUppercase(options.customerType),
      customerId: options.customerId,
    },
  });

  const catalogsWithDbSubscriptions = new Set<string>();
  for (const s of dbSubscriptions) {
    const product = s.productId ? getOrUndefined(products, s.productId) : s.product as yup.InferType<typeof productSchema>;
    if (!product) continue;
    subscriptions.push({
      id: s.id,
      productId: s.productId,
      product,
      quantity: s.quantity,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      status: s.status,
      createdAt: s.createdAt,
      stripeSubscriptionId: s.stripeSubscriptionId,
    });
    if (product.catalogId !== undefined) {
      catalogsWithDbSubscriptions.add(product.catalogId);
    }
  }

  for (const catalogId of Object.keys(catalogs)) {
    if (catalogsWithDbSubscriptions.has(catalogId)) continue;
    const productsInCatalog = typedEntries(products).filter(([_, product]) => product.catalogId === catalogId);
    const defaultCatalogProducts = productsInCatalog.filter(([_, product]) => product.prices === "include-by-default");
    if (defaultCatalogProducts.length > 1) {
      throw new StackAssertionError(
        "Multiple include-by-default products configured in the same catalog",
        { catalogId, productIds: defaultCatalogProducts.map(([id]) => id) },
      );
    }
    if (defaultCatalogProducts.length > 0) {
      const product = defaultCatalogProducts[0];
      subscriptions.push({
        id: null,
        productId: product[0],
        product: product[1],
        quantity: 1,
        currentPeriodStart: DEFAULT_PRODUCT_START_DATE,
        currentPeriodEnd: null,
        status: SubscriptionStatus.active,
        createdAt: DEFAULT_PRODUCT_START_DATE,
        stripeSubscriptionId: null,
      });
    }
  }

  const ungroupedDefaults = typedEntries(products).filter(([id, product]) => (
    product.catalogId === undefined && product.prices === "include-by-default" && !subscriptions.some((s) => s.productId === id)
  ));
  for (const [productId, product] of ungroupedDefaults) {
    subscriptions.push({
      id: null,
      productId,
      product,
      quantity: 1,
      currentPeriodStart: DEFAULT_PRODUCT_START_DATE,
      currentPeriodEnd: null,
      status: SubscriptionStatus.active,
      createdAt: DEFAULT_PRODUCT_START_DATE,
      stripeSubscriptionId: null,
    });
  }

  return subscriptions;
}

export async function getCustomerPurchaseContext(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  customerType: "user" | "team" | "custom",
  customerId: string,
  productId?: string,
}) {
  const existingOneTimePurchases = await options.prisma.oneTimePurchase.findMany({
    where: {
      tenancyId: options.tenancy.id,
      customerId: options.customerId,
      customerType: typedToUppercase(options.customerType),
    },
  });

  const subscriptions = await getSubscriptions({
    prisma: options.prisma,
    tenancy: options.tenancy,
    customerType: options.customerType,
    customerId: options.customerId,
  });

  const alreadyOwnsProduct = options.productId
    ? [...subscriptions, ...existingOneTimePurchases].some((p) => p.productId === options.productId)
    : false;

  return { existingOneTimePurchases, subscriptions, alreadyOwnsProduct };
}

export async function ensureCustomerExists(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
}) {
  if (options.customerType === "user") {
    if (!isUuid(options.customerId)) {
      throw new KnownErrors.UserNotFound();
    }
    const user = await options.prisma.projectUser.findUnique({
      where: {
        tenancyId_projectUserId: {
          tenancyId: options.tenancyId,
          projectUserId: options.customerId,
        },
      },
    });
    if (!user) {
      throw new KnownErrors.UserNotFound();
    }
  } else if (options.customerType === "team") {
    if (!isUuid(options.customerId)) {
      throw new KnownErrors.TeamNotFound(options.customerId);
    }
    const team = await options.prisma.team.findUnique({
      where: {
        tenancyId_teamId: {
          tenancyId: options.tenancyId,
          teamId: options.customerId,
        },
      },
    });
    if (!team) {
      throw new KnownErrors.TeamNotFound(options.customerId);
    }
  }
}

export function productToInlineProduct(product: Product): yup.InferType<typeof inlineProductSchema> {
  return {
    display_name: product.displayName ?? "Product",
    customer_type: product.customerType,
    stackable: product.stackable === true,
    server_only: product.serverOnly === true,
    included_items: product.includedItems,
    prices: product.prices === "include-by-default" ? {} : typedFromEntries(typedEntries(product.prices).map(([key, value]) => [key, filterUndefined({
      ...typedFromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, getOrUndefined(value, c.code)])),
      interval: value.interval,
      free_trial: value.freeTrial,
    })])),
  };
}

export async function validatePurchaseSession(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  codeData: {
    tenancyId: string,
    customerId: string,
    productId?: string,
    product: Product,
  },
  priceId: string | undefined,
  quantity: number,
}): Promise<{
  selectedPrice: SelectedPrice | undefined,
  catalogId: string | undefined,
  subscriptions: Subscription[],
  conflictingCatalogSubscriptions: Subscription[],
}> {
  const { prisma, tenancy, codeData, priceId, quantity } = options;
  const product = codeData.product;
  await ensureCustomerExists({
    prisma,
    tenancyId: tenancy.id,
    customerType: product.customerType,
    customerId: codeData.customerId,
  });

  let selectedPrice: SelectedPrice | undefined = undefined;
  if (!priceId && product.prices !== "include-by-default") {
    selectedPrice = typedValues(product.prices)[0];
  }
  if (priceId && product.prices !== "include-by-default") {
    const pricesMap = new Map(typedEntries(product.prices));
    selectedPrice = pricesMap.get(priceId);
    if (!selectedPrice) {
      throw new StatusError(400, "Price not found on product associated with this purchase code");
    }
  }
  if (quantity !== 1 && product.stackable !== true) {
    throw new StatusError(400, "This product is not stackable; quantity must be 1");
  }

  const { existingOneTimePurchases, subscriptions, alreadyOwnsProduct } = await getCustomerPurchaseContext({
    prisma,
    tenancy,
    customerType: product.customerType,
    customerId: codeData.customerId,
    productId: codeData.productId,
  });

  if (codeData.productId && product.stackable !== true && alreadyOwnsProduct) {
    throw new KnownErrors.ProductAlreadyGranted(codeData.productId, codeData.customerId);
  }
  const addOnProductIds = product.isAddOnTo ? typedKeys(product.isAddOnTo) : [];
  if (product.isAddOnTo && !subscriptions.some((s) => s.productId && addOnProductIds.includes(s.productId))) {
    throw new StatusError(400, "This product is an add-on to a product that the customer does not have");
  }

  const catalogs = tenancy.config.payments.catalogs;
  const catalogId = typedKeys(catalogs).find((g) => product.catalogId === g);

  // Block purchasing any product in the same catalog if a one-time purchase exists in that catalog
  if (catalogId) {
    const hasOneTimeInCatalog = existingOneTimePurchases.some((p) => {
      const product = p.product as yup.InferType<typeof productSchema>;
      return product.catalogId === catalogId;
    });
    if (hasOneTimeInCatalog) {
      throw new StatusError(400, "Customer already has a one-time purchase in this product catalog");
    }
  }

  let conflictingCatalogSubscriptions: Subscription[] = [];
  if (catalogId) {
    conflictingCatalogSubscriptions = subscriptions.filter((subscription) => (
      subscription.id &&
      subscription.productId &&
      subscription.product.catalogId === catalogId &&
      isActiveSubscription(subscription) &&
      subscription.product.prices !== "include-by-default" &&
      (!product.isAddOnTo || !addOnProductIds.includes(subscription.productId))
    ));
  }

  return { selectedPrice, catalogId, subscriptions, conflictingCatalogSubscriptions };
}

export function getClientSecretFromStripeSubscription(subscription: Stripe.Subscription): string {
  const latestInvoice = subscription.latest_invoice;
  if (latestInvoice && typeof latestInvoice !== "string") {
    type InvoiceWithExtras = Stripe.Invoice & {
      confirmation_secret?: { client_secret?: string },
      payment_intent?: string | (Stripe.PaymentIntent & { client_secret?: string }) | null,
    };
    const invoice = latestInvoice as InvoiceWithExtras;
    const confirmationSecret = invoice.confirmation_secret?.client_secret;
    const piSecret = typeof invoice.payment_intent !== "string" ? invoice.payment_intent?.client_secret : undefined;
    if (typeof confirmationSecret === "string") return confirmationSecret;
    if (typeof piSecret === "string") return piSecret;
  }
  throwErr(500, "No client secret returned from Stripe for subscription");
}

type GrantProductResult =
  | {
    type: "one_time",
    purchaseId: string | null,
  }
  | {
    type: "subscription",
    subscriptionId: string,
  };

export async function grantProductToCustomer(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  customerType: "user" | "team" | "custom",
  customerId: string,
  product: Product,
  quantity: number,
  productId: string | undefined,
  priceId: string | undefined,
  creationSource: PurchaseCreationSource,
}): Promise<GrantProductResult> {
  const { prisma, tenancy, customerId, customerType, product, productId, priceId, quantity, creationSource } = options;
  const { selectedPrice, conflictingCatalogSubscriptions } = await validatePurchaseSession({
    prisma,
    tenancy,
    codeData: {
      tenancyId: tenancy.id,
      customerId,
      productId,
      product,
    },
    priceId,
    quantity,
  });

  if (conflictingCatalogSubscriptions.length > 0) {
    const conflicting = conflictingCatalogSubscriptions[0];
    if (conflicting.stripeSubscriptionId) {
      const stripe = await getStripeForAccount({ tenancy });
      await stripe.subscriptions.cancel(conflicting.stripeSubscriptionId);
    } else if (conflicting.id) {
      await prisma.subscription.update({
        where: {
          tenancyId_id: {
            tenancyId: tenancy.id,
            id: conflicting.id,
          },
        },
        data: {
          status: SubscriptionStatus.canceled,
          currentPeriodEnd: new Date(),
          cancelAtPeriodEnd: true,
        },
      });
    }
  }

  if (!selectedPrice) {
    return { type: "one_time", purchaseId: null };
  }

  if (!selectedPrice.interval) {
    const purchase = await prisma.oneTimePurchase.create({
      data: {
        tenancyId: tenancy.id,
        customerId,
        customerType: typedToUppercase(customerType),
        productId,
        priceId,
        product,
        quantity,
        creationSource,
      },
    });
    return { type: "one_time", purchaseId: purchase.id };
  }

  const subscription = await prisma.subscription.create({
    data: {
      tenancyId: tenancy.id,
      customerId,
      customerType: typedToUppercase(customerType),
      status: "active",
      productId,
      priceId,
      product,
      quantity,
      currentPeriodStart: new Date(),
      currentPeriodEnd: addInterval(new Date(), selectedPrice.interval!),
      cancelAtPeriodEnd: false,
      creationSource,
    },
  });

  return { type: "subscription", subscriptionId: subscription.id };
}

export type OwnedProduct = {
  id: string | null,
  type: "one_time" | "subscription",
  quantity: number,
  product: Product,
  createdAt: Date,
  sourceId: string,
};

export async function getOwnedProductsForCustomer(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  customerType: "user" | "team" | "custom",
  customerId: string,
}): Promise<OwnedProduct[]> {
  await ensureCustomerExists({
    prisma: options.prisma,
    tenancyId: options.tenancy.id,
    customerType: options.customerType,
    customerId: options.customerId,
  });

  const [subscriptions, oneTimePurchases] = await Promise.all([
    getSubscriptions({
      prisma: options.prisma,
      tenancy: options.tenancy,
      customerType: options.customerType,
      customerId: options.customerId,
    }),
    options.prisma.oneTimePurchase.findMany({
      where: {
        tenancyId: options.tenancy.id,
        customerId: options.customerId,
        customerType: typedToUppercase(options.customerType),
      },
    }),
  ]);

  const ownedProducts: OwnedProduct[] = [];

  for (const subscription of subscriptions) {
    if (!isActiveSubscription(subscription)) continue;
    const sourceId = subscription.id ?? subscription.productId;
    if (!sourceId) {
      throw new StackAssertionError("Subscription is missing both id and productId", { subscription });
    }
    ownedProducts.push({
      id: subscription.productId,
      type: "subscription",
      quantity: subscription.quantity,
      product: subscription.product,
      createdAt: subscription.createdAt,
      sourceId,
    });
  }

  for (const purchase of oneTimePurchases) {
    const product = purchase.product as Product;
    ownedProducts.push({
      id: purchase.productId ?? null,
      type: "one_time",
      quantity: purchase.quantity,
      product,
      createdAt: purchase.createdAt,
      sourceId: purchase.id,
    });
  }

  return ownedProducts;
}
