import * as yup from "yup";
import { KnownErrors } from ".";
import { isBase64 } from "./utils/bytes";
import { SUPPORTED_CURRENCIES, type Currency, type MoneyAmount } from "./utils/currency-constants";
import { DayInterval, Interval } from "./utils/dates";
import { StackAssertionError, throwErr } from "./utils/errors";
import { decodeBasicAuthorizationHeader } from "./utils/http";
import { allProviders } from "./utils/oauth";
import { deepPlainClone, omit, typedFromEntries } from "./utils/objects";
import { deindent } from "./utils/strings";
import { isValidHostnameWithWildcards, isValidUrl } from "./utils/urls";
import { isUuid } from "./utils/uuids";

const MAX_IMAGE_SIZE_BASE64_BYTES = 1_000_000; // 1MB

declare module "yup" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StringSchema<TType, TContext, TDefault, TFlags> {
    nonEmpty(message?: string): StringSchema<TType, TContext, TDefault, TFlags>,
    empty(): StringSchema<TType, TContext, TDefault, TFlags>,
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Schema<TType, TContext, TDefault, TFlags> {
    hasNested<K extends keyof NonNullable<TType>>(path: K): boolean,
    getNested<K extends keyof NonNullable<TType>>(path: K): yup.Schema<NonNullable<TType>[K], TContext, TDefault, TFlags>,

    // the default types for concat kinda suck, so let's fix that
    concat<U extends yup.AnySchema>(schema: U): yup.Schema<Omit<NonNullable<TType>, keyof yup.InferType<U>> & yup.InferType<U> | (TType & (null | undefined)), TContext, Omit<NonNullable<TDefault>, keyof U['__default']> & U['__default'] | (TDefault & (null | undefined)), TFlags>,
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export interface CustomSchemaMetadata {
    stackSchemaInfo?:
    | {
      type: "object" | "array" | "string" | "number" | "boolean" | "date" | "mixed" | "never",
    }
    | {
      type: "tuple",
      items: yup.AnySchema[],
    }
    | {
      type: "union",
      items: yup.AnySchema[],
    }
    | {
      type: "record",
      keySchema: yup.StringSchema<any>,
      valueSchema: yup.AnySchema,
    },
  }
}

// eslint-disable-next-line no-restricted-syntax
yup.addMethod(yup.string, "nonEmpty", function (message?: string) {
  return this.test(
    "non-empty",
    message ?? (({ path }) => `${path} must not be empty`),
    (value) => {
      return value !== "";
    }
  );
});

yup.addMethod(yup.Schema, "hasNested", function (path: any) {
  if (!path.match(/^[a-zA-Z0-9_$:-]+$/)) throw new StackAssertionError(`yupSchema.hasNested can currently only be used with alphanumeric keys, underscores, dollar signs, colons, and hyphens. Fix this in the future. Provided key: ${JSON.stringify(path)}`);
  const schemaInfo = this.meta()?.stackSchemaInfo as any;
  if (schemaInfo?.type === "record") {
    return schemaInfo.keySchema.isValidSync(path);
  } else if (schemaInfo?.type === "union") {
    return schemaInfo.items.some((s: any) => s.hasNested(path));
  } else {
    try {
      yup.reach(this, path);
      return true as any;
    } catch (e) {
      if (e instanceof Error && e.message.includes("The schema does not contain the path")) {
        return false as any;
      }
      throw e;
    }
  }
});

yup.addMethod(yup.Schema, "getNested", function (path: any) {
  if (!path.match(/^[a-zA-Z0-9_$:-]+$/)) throw new StackAssertionError(`yupSchema.getNested can currently only be used with alphanumeric keys, underscores, dollar signs, colons, and hyphens. Fix this in the future. Provided key: ${path}`);

  if (!this.hasNested(path as never)) throw new StackAssertionError(`Tried to call yupSchema.getNested, but key is not present in the schema. Provided key: ${path}`, { path, schema: this });

  const schemaInfo = this.meta()?.stackSchemaInfo;
  if (schemaInfo?.type === "record") {
    return schemaInfo.valueSchema;
  } else if (schemaInfo?.type === "union") {
    const schemasWithNested = schemaInfo.items.filter((s: any) => s.hasNested(path));
    return yupUnion(...schemasWithNested.map(s => s.getNested(path)));
  } else {
    return yup.reach(this, path) as any;
  }
});

import.meta.vitest?.test("hasNested", ({ expect }) => {
  expect(yupObject({ a: yupString() }).hasNested("a")).toBe(true);
  expect(yupObject({}).hasNested("a" as never)).toBe(false);
  expect(yupRecord(yupString(), yupString()).hasNested("a")).toBe(true);
  expect(yupRecord(yupString().oneOf(["a"]), yupString()).hasNested("b")).toBe(false);
  expect(yupUnion(yupString(), yupNumber()).hasNested("a" as any)).toBe(false);
  expect(yupUnion(yupString(), yupObject({ b: yupNumber() })).hasNested("a" as never)).toBe(false);
  expect(yupUnion(yupString(), yupObject({ a: yupNumber() })).hasNested("a" as never)).toBe(true);
});
import.meta.vitest?.test("getNested", ({ expect }) => {
  expect(yupObject({ a: yupNumber() }).getNested("a").describe().type).toEqual("number");
  expect(() => yupObject({}).getNested("a" as never)).toThrow();
  expect(() => yupObject({ a: yupObject({ b: yupString() }) }).getNested("a.b" as never)).toThrow();
  expect(yupRecord(yupString().oneOf(["a"]), yupNumber()).getNested("a").describe().type).toEqual("number");
  expect(() => yupRecord(yupString().oneOf(["a"]), yupString()).getNested("b" as never)).toThrow();
  expect(yupUnion(yupString(), yupObject({ a: yupNumber() })).getNested("a" as never).describe().type).toEqual("mixed");
  expect(yupUnion(yupObject({ a: yupString() }), yupObject({ a: yupNumber() })).getNested("a").describe().type).toEqual("mixed");
});

export async function yupValidate<S extends yup.ISchema<any>>(
  schema: S,
  obj: unknown,
  options?: yup.ValidateOptions & { currentUserId?: string | null }
): Promise<yup.InferType<S>> {
  try {
    return await schema.validate(obj, {
      ...omit(options ?? {}, ['currentUserId']),
      context: {
        ...options?.context,
        stackAllowUserIdMe: options?.currentUserId !== undefined,
      },
    });
  } catch (error) {
    if (error instanceof ReplaceFieldWithOwnUserId) {
      const currentUserId = options?.currentUserId;
      if (!currentUserId) throw new KnownErrors.CannotGetOwnUserWithoutUser();

      // parse yup path
      let pathRemaining = error.path;
      const fieldPath = [];
      while (pathRemaining.length > 0) {
        if (pathRemaining.startsWith("[")) {
          const index = pathRemaining.indexOf("]");
          if (index < 0) throw new StackAssertionError("Invalid path");
          fieldPath.push(JSON.parse(pathRemaining.slice(1, index)));
          pathRemaining = pathRemaining.slice(index + 1);
        } else {
          let dotIndex = pathRemaining.indexOf(".");
          if (dotIndex === -1) dotIndex = pathRemaining.length;
          fieldPath.push(pathRemaining.slice(0, dotIndex));
          pathRemaining = pathRemaining.slice(dotIndex + 1);
        }
      }

      const newObj = deepPlainClone(obj);
      let it = newObj;
      for (const field of fieldPath.slice(0, -1)) {
        if (!Object.prototype.hasOwnProperty.call(it, field)) {
          throw new StackAssertionError(`Segment ${field} of path ${error.path} not found in object`);
        }
        it = (it as any)[field];
      }
      (it as any)[fieldPath[fieldPath.length - 1]] = currentUserId;

      return await yupValidate(schema, newObj, options);
    }
    throw error;
  }
}

const _idDescription = (identify: string) => `The unique identifier of the ${identify}`;
const _displayNameDescription = (identify: string) => `Human-readable ${identify} display name. This is not a unique identifier.`;
const _clientMetaDataDescription = (identify: string) => `Client metadata. Used as a data store, accessible from the client side. Do not store information that should not be exposed to the client.`;
const _clientReadOnlyMetaDataDescription = (identify: string) => `Client read-only, server-writable metadata. Used as a data store, accessible from the client side. Do not store information that should not be exposed to the client. The client can read this data, but cannot modify it. This is useful for things like subscription status.`;
const _profileImageUrlDescription = (identify: string) => `URL of the profile image for ${identify}. Can be a Base64 encoded image. Must be smaller than 100KB. Please compress and crop to a square before passing in.`;
const _serverMetaDataDescription = (identify: string) => `Server metadata. Used as a data store, only accessible from the server side. You can store secret information related to the ${identify} here.`;
const _atMillisDescription = (identify: string) => `(the number of milliseconds since epoch, January 1, 1970, UTC)`;
const _createdAtMillisDescription = (identify: string) => `The time the ${identify} was created ${_atMillisDescription(identify)}`;
const _signedUpAtMillisDescription = `The time the user signed up ${_atMillisDescription}`;
const _lastActiveAtMillisDescription = `The time the user was last active ${_atMillisDescription}`;


declare const StackAdaptSentinel: unique symbol;
export type StackAdaptSentinel = typeof StackAdaptSentinel;

// Built-in replacements
export function yupString<A extends string, B extends yup.Maybe<yup.AnyObject> = yup.AnyObject>(...args: Parameters<typeof yup.string<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.string(...args).meta({ stackSchemaInfo: { type: "string" } });
}
export function yupNumber<A extends number, B extends yup.Maybe<yup.AnyObject> = yup.AnyObject>(...args: Parameters<typeof yup.number<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.number(...args).meta({ stackSchemaInfo: { type: "number" } });
}
export function yupBoolean<A extends boolean, B extends yup.Maybe<yup.AnyObject> = yup.AnyObject>(...args: Parameters<typeof yup.boolean<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.boolean(...args).meta({ stackSchemaInfo: { type: "boolean" } });
}
/**
 * @deprecated, use number of milliseconds since epoch instead
 */
export function yupDate<A extends Date, B extends yup.Maybe<yup.AnyObject> = yup.AnyObject>(...args: Parameters<typeof yup.date<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.date(...args).meta({ stackSchemaInfo: { type: "date" } });
}
function _yupMixedInternal<A extends {}>(...args: Parameters<typeof yup.mixed<A>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.mixed(...args);
}
export function yupMixed<A extends {}>(...args: Parameters<typeof yup.mixed<A>>) {
  return _yupMixedInternal(...args).meta({ stackSchemaInfo: { type: "mixed" } });
}
export function yupArray<A extends yup.Maybe<yup.AnyObject> = yup.AnyObject, B = any>(...args: Parameters<typeof yup.array<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  return yup.array(...args).meta({ stackSchemaInfo: { type: "array" } });
}
export function yupTuple<T extends [unknown, ...unknown[]]>(schemas: { [K in keyof T]: yup.Schema<T[K]> }) {
  if (schemas.length === 0) throw new Error('yupTuple must have at least one schema');
  // eslint-disable-next-line no-restricted-syntax
  return yup.tuple<T>(schemas as any).meta({ stackSchemaInfo: { type: "tuple", items: schemas } });
}
export function yupObjectWithAutoDefault<A extends yup.Maybe<yup.AnyObject>, B extends yup.ObjectShape>(...args: Parameters<typeof yup.object<A, B>>) {
  // eslint-disable-next-line no-restricted-syntax
  const object = yup.object(...args).test(
    'no-unknown-object-properties',
    ({ path }) => `${path} contains unknown properties`,
    (value: any, context) => {
      if (context.options.context?.noUnknownPathPrefixes?.some((prefix: string) => context.path.startsWith(prefix))) {
        if (context.schema.spec.noUnknown !== false) {
          const availableKeys = new Set(Object.keys(context.schema.fields));
          const unknownKeys = Object.keys(value ?? {}).filter(key => !availableKeys.has(key));
          if (unknownKeys.length > 0) {
            // TODO "did you mean XYZ"
            return context.createError({
              message: `${context.path || "Object"} contains unknown properties: ${unknownKeys.join(', ')}`,
              path: context.path,
              params: { unknownKeys, availableKeys },
            });
          }
        }
      }
      return true;
    },
  ).meta({ stackSchemaInfo: { type: "object" } });
  return object;
}
export function yupObject<A extends yup.Maybe<yup.AnyObject>, B extends yup.ObjectShape>(...args: Parameters<typeof yup.object<A, B>>) {
  // we don't want to update the type of `object` to have a default flag
  const object = yupObjectWithAutoDefault(...args);
  return object.default(undefined) as any as typeof object;
}

export function yupNever(): yup.MixedSchema<never> {
  return _yupMixedInternal().meta({ stackSchemaInfo: { type: "never" } }).test('never', 'This value should never be reached', () => false) as any;
}

export function yupUnion<T extends yup.AnySchema[]>(...args: T): yup.MixedSchema<yup.InferType<T[number]>> {
  if (args.length === 0) throw new Error('yupUnion must have at least one schema');

  return _yupMixedInternal().meta({ stackSchemaInfo: { type: "union", items: args } }).test('is-one-of', 'Invalid value', async (value, context) => {
    if (value == null) return true;
    const errors = [];
    for (const schema of args) {
      try {
        await yupValidate(schema, value, context.options);
        return true;
      } catch (e) {
        errors.push(e);
      }
    }
    return context.createError({
      message: deindent`
        ${context.path} is not matched by any of the provided schemas:
          ${errors.map((e: any, i) => deindent`
            Schema ${i}:
              ${e.errors.join('\n')}
          `).join('\n')}`,
      path: context.path,
    });
  });
}

export function yupRecord<K extends yup.StringSchema, T extends yup.AnySchema>(
  keySchema: K,
  valueSchema: T,
): yup.MixedSchema<Record<yup.InferType<K> & string, yup.InferType<T>>> {
  return yupObject().meta({ stackSchemaInfo: { type: "record", keySchema, valueSchema } }).unknown(true).test(
    'record',
    '${path} must be a record of valid values',
    async function (value: unknown, context: yup.TestContext) {
      if (value == null) return true;
      const { path, createError } = this as any;
      if (typeof value !== 'object') {
        return createError({ message: `${path} must be an object` });
      }

      // Validate each property using the provided valueSchema
      for (const key of Object.keys(value)) {
        // Validate the key
        await yupValidate(keySchema, key, context.options);

        // Validate the value
        try {
          await yupValidate(valueSchema, (value as Record<string, unknown>)[key], {
            ...context.options,
            context: {
              ...context.options.context,
              path: path ? `${path}.${key}` : key,
            },
          });
        } catch (e: any) {
          return createError({
            path: path ? `${path}.${key}` : key,
            message: e.message,
          });
        }
      }

      return true;
    },
  ) as any;
}

export function ensureObjectSchema<T extends yup.AnyObject>(schema: yup.Schema<T>): yup.ObjectSchema<T> & typeof schema {
  if (!(schema instanceof yup.ObjectSchema)) throw new StackAssertionError(`assertObjectSchema: schema is not an ObjectSchema: ${schema.describe().type}`);
  return schema as any;
}

// Common
export const adaptSchema = yupMixed<StackAdaptSentinel>();
/**
 * Yup's URL schema does not recognize some URLs (including `http://localhost`) as a valid URL. This schema is a workaround for that.
 */
export const urlSchema = yupString().test({
  name: 'no-spaces',
  message: (params) => `${params.path} contains spaces`,
  test: (value) => value == null || !value.includes(' ')
}).test({
  name: 'url',
  message: (params) => `${params.path} is not a valid URL`,
  test: (value) => value == null || isValidUrl(value)
});
/**
 * URL schema that supports wildcard patterns in hostnames (e.g., "https://*.example.com", "http://*:8080")
 */
export const wildcardUrlSchema = yupString().test({
  name: 'no-spaces',
  message: (params) => `${params.path} contains spaces`,
  test: (value) => value == null || !value.includes(' ')
}).test({
  name: 'wildcard-url',
  message: (params) => `${params.path} is not a valid URL or wildcard URL pattern`,
  test: (value) => {
    if (value == null) return true;

    // If it doesn't contain wildcards, use the regular URL validation
    if (!value.includes('*')) {
      return isValidUrl(value);
    }

    // For wildcard URLs, validate the structure by replacing wildcards with placeholders
    try {
      const PLACEHOLDER = 'wildcard-placeholder';
      // Replace wildcards with valid placeholders for URL parsing
      const normalizedUrl = value.replace(/\*/g, PLACEHOLDER);
      const url = new URL(normalizedUrl);

      // Only allow wildcards in the hostname; reject anywhere else
      if (
        url.username.includes(PLACEHOLDER) ||
        url.password.includes(PLACEHOLDER) ||
        url.pathname.includes(PLACEHOLDER) ||
        url.search.includes(PLACEHOLDER) ||
        url.hash.includes(PLACEHOLDER)
      ) {
        return false;
      }

      // Only http/https are acceptable
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return false;
      }

      // Extract original hostname pattern from the input
      const hostPattern = url.hostname.split(PLACEHOLDER).join('*');

      // Validate the wildcard hostname pattern using the existing function
      return isValidHostnameWithWildcards(hostPattern);
    } catch (e) {
      return false;
    }
  }
});
export const jsonSchema = yupMixed().nullable().defined().transform((value) => JSON.parse(JSON.stringify(value)));
export const jsonStringSchema = yupString().test("json", (params) => `${params.path} is not valid JSON`, (value) => {
  if (value == null) return true;
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    return false;
  }
});
export const jsonStringOrEmptySchema = yupString().test("json", (params) => `${params.path} is not valid JSON`, (value) => {
  if (!value) return true;
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    return false;
  }
});
export const base64Schema = yupString().test("is-base64", (params) => `${params.path} is not valid base64`, (value) => {
  if (value == null) return true;
  return isBase64(value);
});
export const passwordSchema = yupString().max(70);
export const intervalSchema = yupTuple<Interval>([yupNumber().min(0).integer().defined(), yupString().oneOf(['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'year']).defined()]);
export const dayIntervalSchema = yupTuple<DayInterval>([yupNumber().min(0).integer().defined(), yupString().oneOf(['day', 'week', 'month', 'year']).defined()]);
export const intervalOrNeverSchema = yupUnion(intervalSchema.defined(), yupString().oneOf(['never']).defined());
export const dayIntervalOrNeverSchema = yupUnion(dayIntervalSchema.defined(), yupString().oneOf(['never']).defined());
/**
 * This schema is useful for fields where the user can specify the ID, such as price IDs. It is particularly common
 * for IDs in the config schema.
 */
export const userSpecifiedIdSchema = (idName: `${string}Id`) => yupString().max(63).matches(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, `${idName} must start with a letter, underscore, or number, and contain only letters, numbers, underscores, and hyphens`);
export const moneyAmountSchema = (currency: Currency) => yupString<MoneyAmount>().test('money-amount', 'Invalid money amount', (value, context) => {
  if (value == null) return true;
  const regex = /^([0-9]+)(\.([0-9]+))?$/;
  const match = value.match(regex);
  if (!match) return context.createError({ message: 'Money amount must be in the format of <number> or <number>.<number>' });
  const whole = match[1];
  const decimals = match[3];
  if (decimals && decimals.length > currency.decimals) return context.createError({ message: `Too many decimals; ${currency.code} only has ${currency.decimals} decimals` });
  if (whole !== '0' && whole.startsWith('0')) return context.createError({ message: 'Money amount must not have leading zeros' });
  return true;
});


/**
 * A stricter email schema that does some additional checks for UX input. (Some emails are allowed by the spec, for
 * example `test@localhost` or `abc@gmail`, but almost certainly a user input error.)
 *
 * Note that some users in the DB have an email that doesn't match this regex, so most of the time you should use
 * `emailSchema` instead until we do the DB migration.
 */
// eslint-disable-next-line no-restricted-syntax
export const strictEmailSchema = (message: string | undefined) => yupString().email(message).max(256).matches(/^[^.]+(\.[^.]+)*@.*\.[^.][^.]+$/, message);
// eslint-disable-next-line no-restricted-syntax
export const emailSchema = yupString().email();

import.meta.vitest?.test('strictEmailSchema', ({ expect }) => {
  const validEmails = [
    "a@example.com",
    "abc@example.com",
    "a.b@example.com",
    "throwaway.mail+token@example.com",
    "email-alt-dash@demo-mail.com",
    "test-account@weird-domain.net",
    "%!~&+{}=|`#@domain.test",
    "admin@a.longtldexample",
  ];
  for (const email of validEmails) {
    expect(strictEmailSchema(undefined).validateSync(email)).toBe(email);
  }
  const invalidEmails = [
    "test@localhost",
    "test@gmail",
    "test@gmail.com.a",
    "test@gmail.a",
    "test.@example.com",
    "test..test@example.com",
    ".test@example.com",
  ];
  for (const email of invalidEmails) {
    expect(() => strictEmailSchema(undefined).validateSync(email)).toThrow();
  }
});

// Request auth
export const clientOrHigherAuthTypeSchema = yupString().oneOf(['client', 'server', 'admin']).defined();
export const serverOrHigherAuthTypeSchema = yupString().oneOf(['server', 'admin']).defined();
export const adminAuthTypeSchema = yupString().oneOf(['admin']).defined();

// Projects
export const projectIdSchema = yupString().test((v) => v === undefined || v === "internal" || isUuid(v)).meta({ openapiField: { description: _idDescription('project'), exampleValue: 'e0b52f4d-dece-408c-af49-d23061bb0f8d' } });
export const projectBranchIdSchema = yupString().nonEmpty().max(255).meta({ openapiField: { description: _idDescription('project branch'), exampleValue: 'main' } });
export const projectDisplayNameSchema = yupString().meta({ openapiField: { description: _displayNameDescription('project'), exampleValue: 'MyMusic' } });
export const projectLogoUrlSchema = urlSchema.max(MAX_IMAGE_SIZE_BASE64_BYTES).meta({ openapiField: { description: 'URL of the logo for the project. This is usually a close to 1:1 image of the company logo.', exampleValue: 'https://example.com/logo.png' } });
export const projectFullLogoUrlSchema = urlSchema.max(MAX_IMAGE_SIZE_BASE64_BYTES).meta({ openapiField: { description: 'URL of the full logo for the project. This is usually a vertical image with the logo and the company name.', exampleValue: 'https://example.com/full-logo.png' } });
export const projectDescriptionSchema = yupString().nullable().meta({ openapiField: { description: 'A human readable description of the project', exampleValue: 'A music streaming service' } });
export const projectCreatedAtMillisSchema = yupNumber().meta({ openapiField: { description: _createdAtMillisDescription('project'), exampleValue: 1630000000000 } });
export const projectIsProductionModeSchema = yupBoolean().meta({ openapiField: { description: 'Whether the project is in production mode', exampleValue: true } });
// Project config
export const projectConfigIdSchema = yupString().meta({ openapiField: { description: _idDescription('project config'), exampleValue: 'd09201f0-54f5-40bd-89ff-6d1815ddad24' } });
export const projectAllowLocalhostSchema = yupBoolean().meta({ openapiField: { description: 'Whether localhost is allowed as a domain for this project. Should only be allowed in development mode', exampleValue: true } });
export const projectCreateTeamOnSignUpSchema = yupBoolean().meta({ openapiField: { description: 'Whether a team should be created for each user that signs up', exampleValue: true } });
export const projectMagicLinkEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether magic link authentication is enabled for this project', exampleValue: true } });
export const projectPasskeyEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether passkey authentication is enabled for this project', exampleValue: true } });
export const projectClientTeamCreationEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether client users can create teams', exampleValue: true } });
export const projectClientUserDeletionEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether client users can delete their own account from the client', exampleValue: true } });
export const projectSignUpEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether users can sign up new accounts, or whether they are only allowed to sign in to existing accounts. Regardless of this option, the server API can always create new users with the `POST /users` endpoint.', exampleValue: true } });
export const projectCredentialEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether email password authentication is enabled for this project', exampleValue: true } });
// Project OAuth config
export const oauthIdSchema = yupString().oneOf(allProviders).meta({ openapiField: { description: `OAuth provider ID, one of ${allProviders.map(x => `\`${x}\``).join(', ')}`, exampleValue: 'google' } });
export const oauthEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether the OAuth provider is enabled. If an provider is first enabled, then disabled, it will be shown in the list but with enabled=false', exampleValue: true } });
export const oauthTypeSchema = yupString().oneOf(['shared', 'standard']).meta({ openapiField: { description: 'OAuth provider type, one of shared, standard. "shared" uses Stack shared OAuth keys and it is only meant for development. "standard" uses your own OAuth keys and will show your logo and company name when signing in with the provider.', exampleValue: 'standard' } });
export const oauthClientIdSchema = yupString().meta({ openapiField: { description: 'OAuth client ID. Needs to be specified when using type="standard"', exampleValue: 'google-oauth-client-id' } });
export const oauthClientSecretSchema = yupString().meta({ openapiField: { description: 'OAuth client secret. Needs to be specified when using type="standard"', exampleValue: 'google-oauth-client-secret' } });
export const oauthFacebookConfigIdSchema = yupString().meta({ openapiField: { description: 'The configuration id for Facebook business login (for things like ads and marketing). This is only required if you are using the standard OAuth with Facebook and you are using Facebook business login.' } });
export const oauthMicrosoftTenantIdSchema = yupString().meta({ openapiField: { description: 'The Microsoft tenant id for Microsoft directory. This is only required if you are using the standard OAuth with Microsoft and you have an Azure AD tenant.' } });
export const oauthAccountMergeStrategySchema = yupString().oneOf(['link_method', 'raise_error', 'allow_duplicates']).meta({ openapiField: { description: 'Determines how to handle OAuth logins that match an existing user by email. `link_method` adds the OAuth method to the existing user. `raise_error` rejects the login with an error. `allow_duplicates` creates a new user.', exampleValue: 'link_method' } });
// Project email config
export const emailTypeSchema = yupString().oneOf(['shared', 'standard']).meta({ openapiField: { description: 'Email provider type, one of shared, standard. "shared" uses Stack shared email provider and it is only meant for development. "standard" uses your own email server and will have your email address as the sender.', exampleValue: 'standard' } });
export const emailSenderNameSchema = yupString().meta({ openapiField: { description: 'Email sender name. Needs to be specified when using type="standard"', exampleValue: 'Stack' } });
export const emailHostSchema = yupString().meta({ openapiField: { description: 'Email host. Needs to be specified when using type="standard"', exampleValue: 'smtp.your-domain.com' } });
export const emailPortSchema = yupNumber().min(0).max(65535).meta({ openapiField: { description: 'Email port. Needs to be specified when using type="standard"', exampleValue: 587 } });
export const emailUsernameSchema = yupString().meta({ openapiField: { description: 'Email username. Needs to be specified when using type="standard"', exampleValue: 'smtp-email' } });
export const emailSenderEmailSchema = emailSchema.meta({ openapiField: { description: 'Email sender email. Needs to be specified when using type="standard"', exampleValue: 'example@your-domain.com' } });
export const emailPasswordSchema = passwordSchema.meta({ openapiField: { description: 'Email password. Needs to be specified when using type="standard"', exampleValue: 'your-email-password' } });
// Project domain config
export const handlerPathSchema = yupString().test('is-handler-path', 'Handler path must start with /', (value) => value?.startsWith('/')).meta({ openapiField: { description: 'Handler path. If you did not setup a custom handler path, it should be "/handler" by default. It needs to start with /', exampleValue: '/handler' } });
// Project email theme config
export const emailThemeSchema = yupString().meta({ openapiField: { description: 'Email theme id for the project. Determines the visual style of emails sent by the project.' } });
export const emailThemeListSchema = yupRecord(
  yupString().uuid(),
  yupObject({
    displayName: yupString().meta({ openapiField: { description: 'Email theme name', exampleValue: 'Default Light' } }).defined(),
    tsxSource: yupString().meta({ openapiField: { description: 'Email theme source code tsx component' } }).defined(),
  })
).meta({ openapiField: { description: 'Record of email theme IDs to their display name and source code' } });
export const templateThemeIdSchema = yupMixed<string | false>().test((v: any) => v === undefined || v === false || v === null || (typeof v === 'string' && isUuid(v))).meta({ openapiField: { description: 'Email theme id for the template' } }).optional();
export const emailTemplateListSchema = yupRecord(
  yupString().uuid(),
  yupObject({
    displayName: yupString().meta({ openapiField: { description: 'Email template name', exampleValue: 'Email Verification' } }).defined(),
    tsxSource: yupString().meta({ openapiField: { description: 'Email template source code tsx component' } }).defined(),
    // themeId can be one of three values:
    // 1. A valid theme id
    // 2. false, which means the template uses no theme
    // 3. undefined/not given, which means the template uses the project's active theme
    themeId: templateThemeIdSchema,
  })
).meta({ openapiField: { description: 'Record of email template IDs to their display name and source code' } });

// Payments
export const customerTypeSchema = yupString().oneOf(['user', 'team', 'custom']);
const validateHasAtLeastOneSupportedCurrency = (value: Record<string, unknown>, context: any) => {
  const currencies = Object.keys(value).filter(key => SUPPORTED_CURRENCIES.some(c => c.code === key));
  if (currencies.length === 0) {
    return context.createError({ message: "At least one currency is required" });
  }
  return true;
};
export const offerPriceSchema = yupObject({
  ...typedFromEntries(SUPPORTED_CURRENCIES.map(currency => [currency.code, moneyAmountSchema(currency).optional()])),
  interval: dayIntervalSchema.optional(),
  serverOnly: yupBoolean(),
  freeTrial: dayIntervalSchema.optional(),
}).test("at-least-one-currency", (value, context) => validateHasAtLeastOneSupportedCurrency(value, context));
export const priceOrIncludeByDefaultSchema = yupUnion(
  yupString().oneOf(['include-by-default']).meta({ openapiField: { description: 'Makes this item free and includes it by default for all customers.', exampleValue: 'include-by-default' } }),
  yupRecord(
    userSpecifiedIdSchema("priceId"),
    offerPriceSchema,
  ),
);
export const offerSchema = yupObject({
  displayName: yupString(),
  groupId: userSpecifiedIdSchema("groupId").optional().meta({ openapiField: { description: 'The ID of the group this offer belongs to. Within a group, all offers are mutually exclusive unless they are an add-on to another offer in the group.', exampleValue: 'group-id' } }),
  isAddOnTo: yupUnion(
    yupBoolean().isFalse(),
    yupRecord(
      userSpecifiedIdSchema("offerId"),
      yupBoolean().isTrue().defined(),
    ),
  ).optional().meta({ openapiField: { description: 'The offers that this offer is an add-on to. If this is set, the customer must already have one of the offers in the record to be able to purchase this offer.', exampleValue: { "offer-id": true } } }),
  customerType: customerTypeSchema.defined(),
  freeTrial: dayIntervalSchema.optional(),
  serverOnly: yupBoolean(),
  stackable: yupBoolean(),
  prices: priceOrIncludeByDefaultSchema.defined(),
  includedItems: yupRecord(
    userSpecifiedIdSchema("itemId"),
    yupObject({
      quantity: yupNumber().defined(),
      repeat: dayIntervalOrNeverSchema.optional(),
      expires: yupString().oneOf(['never', 'when-purchase-expires', 'when-repeated']).optional(),
    }),
  ),
});
export const inlineOfferSchema = yupObject({
  display_name: yupString().defined(),
  customer_type: customerTypeSchema.defined(),
  free_trial: dayIntervalSchema.optional(),
  server_only: yupBoolean().oneOf([true]).default(true),
  prices: yupRecord(
    userSpecifiedIdSchema("priceId"),
    yupObject({
      ...typedFromEntries(SUPPORTED_CURRENCIES.map(currency => [currency.code, moneyAmountSchema(currency).optional()])),
      interval: dayIntervalSchema.optional(),
      free_trial: dayIntervalSchema.optional(),
    }).test("at-least-one-currency", (value, context) => validateHasAtLeastOneSupportedCurrency(value, context)),
  ),
  included_items: yupRecord(
    userSpecifiedIdSchema("itemId"),
    yupObject({
      quantity: yupNumber(),
      repeat: dayIntervalOrNeverSchema.optional(),
      expires: yupString().oneOf(['never', 'when-purchase-expires', 'when-repeated']).optional(),
    }),
  ),
});

// Users
export class ReplaceFieldWithOwnUserId extends Error {
  constructor(public readonly path: string) {
    super(`This error should be caught by whoever validated the schema, and the field in the path '${path}' should be replaced with the current user's id. This is a workaround to yup not providing access to the context inside the transform function.`);
  }
}
const userIdMeSentinelUuid = "cad564fd-f81b-43f4-b390-98abf3fcc17e";
export const userIdOrMeSchema = yupString().uuid().transform(v => {
  if (v === "me") return userIdMeSentinelUuid;
  else return v;
}).test((v, context) => {
  if (!("stackAllowUserIdMe" in (context.options.context ?? {}))) throw new StackAssertionError('userIdOrMeSchema is not allowed in this context. Make sure you\'re using yupValidate from schema-fields.ts to validate, instead of schema.validate(...).');
  if (!context.options.context?.stackAllowUserIdMe) throw new StackAssertionError('userIdOrMeSchema is not allowed in this context. Make sure you\'re passing in the currentUserId option in yupValidate.');
  if (v === userIdMeSentinelUuid) throw new ReplaceFieldWithOwnUserId(context.path);
  return true;
}).meta({ openapiField: { description: 'The ID of the user, or the special value `me` for the currently authenticated user', exampleValue: '3241a285-8329-4d69-8f3d-316e08cf140c' } });
export const userIdSchema = yupString().uuid().meta({ openapiField: { description: _idDescription('user'), exampleValue: '3241a285-8329-4d69-8f3d-316e08cf140c' } });
export const primaryEmailSchema = emailSchema.meta({ openapiField: { description: 'Primary email', exampleValue: 'johndoe@example.com' } });
export const primaryEmailAuthEnabledSchema = yupBoolean().meta({ openapiField: { description: 'Whether the primary email is used for authentication. If this is set to `false`, the user will not be able to sign in with the primary email with password or OTP', exampleValue: true } });
export const primaryEmailVerifiedSchema = yupBoolean().meta({ openapiField: { description: 'Whether the primary email has been verified to belong to this user', exampleValue: true } });
export const userDisplayNameSchema = yupString().nullable().max(256).meta({ openapiField: { description: _displayNameDescription('user'), exampleValue: 'John Doe' } });
export const selectedTeamIdSchema = yupString().uuid().meta({ openapiField: { description: 'ID of the team currently selected by the user', exampleValue: 'team-id' } });
export const profileImageUrlSchema = urlSchema.max(MAX_IMAGE_SIZE_BASE64_BYTES).meta({ openapiField: { description: _profileImageUrlDescription('user'), exampleValue: 'https://example.com/image.jpg' } });
export const signedUpAtMillisSchema = yupNumber().meta({ openapiField: { description: _signedUpAtMillisDescription, exampleValue: 1630000000000 } });
export const userClientMetadataSchema = jsonSchema.meta({ openapiField: { description: _clientMetaDataDescription('user'), exampleValue: { key: 'value' } } });
export const userClientReadOnlyMetadataSchema = jsonSchema.meta({ openapiField: { description: _clientReadOnlyMetaDataDescription('user'), exampleValue: { key: 'value' } } });
export const userServerMetadataSchema = jsonSchema.meta({ openapiField: { description: _serverMetaDataDescription('user'), exampleValue: { key: 'value' } } });
export const userOAuthProviderSchema = yupObject({
  id: yupString().defined(),
  type: yupString().oneOf(allProviders).defined(),
  provider_user_id: yupString().defined(),
});
export const userLastActiveAtMillisSchema = yupNumber().nullable().meta({ openapiField: { description: _lastActiveAtMillisDescription, exampleValue: 1630000000000 } });
export const userPasskeyAuthEnabledSchema = yupBoolean().meta({ openapiField: { hidden: true, description: 'Whether the user has passkeys enabled', exampleValue: false } });
export const userOtpAuthEnabledSchema = yupBoolean().meta({ openapiField: { hidden: true, description: 'Whether the user has OTP/magic link enabled. ', exampleValue: true } });
export const userOtpAuthEnabledMutationSchema = yupBoolean().meta({ openapiField: { hidden: true, description: 'Whether the user has OTP/magic link enabled. Note that only accounts with verified emails can sign-in with OTP.', exampleValue: true } });
export const userHasPasswordSchema = yupBoolean().meta({ openapiField: { hidden: true, description: 'Whether the user has a password set. If the user does not have a password set, they will not be able to sign in with email/password.', exampleValue: true } });
export const userPasswordMutationSchema = passwordSchema.nullable().meta({ openapiField: { description: 'Sets the user\'s password. Doing so revokes all current sessions.', exampleValue: 'my-new-password' } }).max(70);
export const userPasswordHashMutationSchema = yupString()
  .nonEmpty()
  .meta({ openapiField: { description: 'If `password` is not given, sets the user\'s password hash to the given string in Modular Crypt Format (ex.: `$2a$10$VIhIOofSMqGdGlL4wzE//e.77dAQGqNtF/1dT7bqCrVtQuInWy2qi`). Doing so revokes all current sessions.' } });  // we don't set an exampleValue here because it's exclusive with the password field and having both would break the generated example
export const userTotpSecretMutationSchema = base64Schema.nullable().meta({ openapiField: { description: 'Enables 2FA and sets a TOTP secret for the user. Set to null to disable 2FA.', exampleValue: 'dG90cC1zZWNyZXQ=' } });

// Auth
export const signInEmailSchema = strictEmailSchema(undefined).meta({ openapiField: { description: 'The email to sign in with.', exampleValue: 'johndoe@example.com' } });
export const emailOtpSignInCallbackUrlSchema = urlSchema.meta({ openapiField: { description: 'The base callback URL to construct the magic link from. A query parameter `code` with the verification code will be appended to it. The page should then make a request to the `/auth/otp/sign-in` endpoint.', exampleValue: 'https://example.com/handler/magic-link-callback' } });
export const emailVerificationCallbackUrlSchema = urlSchema.meta({ openapiField: { description: 'The base callback URL to construct a verification link for the verification e-mail. A query parameter `code` with the verification code will be appended to it. The page should then make a request to the `/contact-channels/verify` endpoint.', exampleValue: 'https://example.com/handler/email-verification' } });
export const accessTokenResponseSchema = yupString().meta({ openapiField: { description: 'Short-lived access token that can be used to authenticate the user', exampleValue: 'eyJhmMiJB2TO...diI4QT' } });
export const refreshTokenResponseSchema = yupString().meta({ openapiField: { description: 'Long-lived refresh token that can be used to obtain a new access token', exampleValue: 'i8ns3aq2...14y' } });
export const signInResponseSchema = yupObject({
  refresh_token: refreshTokenResponseSchema.defined(),
  access_token: accessTokenResponseSchema.defined(),
  is_new_user: yupBoolean().meta({ openapiField: { description: 'Whether the user is a new user', exampleValue: true } }).defined(),
  user_id: userIdSchema.defined(),
});

// Permissions
export const teamSystemPermissions = [
  '$update_team',
  '$delete_team',
  '$read_members',
  '$remove_members',
  '$invite_members',
  '$manage_api_keys',
] as const;
export const permissionDefinitionIdSchema = yupString()
  .matches(/^\$?[a-z0-9_:]+$/, 'Only lowercase letters, numbers, ":", "_" and optional "$" at the beginning are allowed')
  .test('is-system-permission', 'System permissions must start with a dollar sign', (value, ctx) => {
    if (!value) return true;
    if (value.startsWith('$') && !teamSystemPermissions.includes(value as any)) {
      return ctx.createError({ message: 'Invalid system permission' });
    }
    return true;
  })
  .meta({ openapiField: { description: `The permission ID used to uniquely identify a permission. Can either be a custom permission with lowercase letters, numbers, \`:\`, and \`_\` characters, or one of the system permissions: ${teamSystemPermissions.map(x => `\`${x}\``).join(', ')}`, exampleValue: 'read_secret_info' } });
export const customPermissionDefinitionIdSchema = yupString()
  .matches(/^[a-z0-9_:]+$/, 'Only lowercase letters, numbers, ":", "_" are allowed')
  .meta({ openapiField: { description: 'The permission ID used to uniquely identify a permission. Can only contain lowercase letters, numbers, ":", and "_" characters', exampleValue: 'read_secret_info' } });
export const teamPermissionDescriptionSchema = yupString().meta({ openapiField: { description: 'A human-readable description of the permission', exampleValue: 'Read secret information' } });
export const containedPermissionIdsSchema = yupArray(permissionDefinitionIdSchema.defined()).meta({ openapiField: { description: 'The IDs of the permissions that are contained in this permission', exampleValue: ['read_public_info'] } });

// Teams
export const teamIdSchema = yupString().uuid().meta({ openapiField: { description: _idDescription('team'), exampleValue: 'ad962777-8244-496a-b6a2-e0c6a449c79e' } });
export const teamDisplayNameSchema = yupString().meta({ openapiField: { description: _displayNameDescription('team'), exampleValue: 'My Team' } });
export const teamProfileImageUrlSchema = urlSchema.max(1000000).meta({ openapiField: { description: _profileImageUrlDescription('team'), exampleValue: 'https://example.com/image.jpg' } });
export const teamClientMetadataSchema = jsonSchema.meta({ openapiField: { description: _clientMetaDataDescription('team'), exampleValue: { key: 'value' } } });
export const teamClientReadOnlyMetadataSchema = jsonSchema.meta({ openapiField: { description: _clientReadOnlyMetaDataDescription('team'), exampleValue: { key: 'value' } } });
export const teamServerMetadataSchema = jsonSchema.meta({ openapiField: { description: _serverMetaDataDescription('team'), exampleValue: { key: 'value' } } });
export const teamCreatedAtMillisSchema = yupNumber().meta({ openapiField: { description: _createdAtMillisDescription('team'), exampleValue: 1630000000000 } });
export const teamInvitationEmailSchema = emailSchema.meta({ openapiField: { description: 'The email of the user to invite.', exampleValue: 'johndoe@example.com' } });
export const teamInvitationCallbackUrlSchema = urlSchema.meta({ openapiField: { description: 'The base callback URL to construct an invite link with. A query parameter `code` with the verification code will be appended to it. The page should then make a request to the `/team-invitations/accept` endpoint.', exampleValue: 'https://example.com/handler/team-invitation' } });
export const teamCreatorUserIdSchema = userIdOrMeSchema.meta({ openapiField: { description: 'The ID of the creator of the team. If not specified, the user will not be added to the team. Can be either "me" or the ID of the user. Only used on the client side.', exampleValue: 'me' } });

// Team member profiles
export const teamMemberDisplayNameSchema = yupString().meta({ openapiField: { description: _displayNameDescription('team member') + ' Note that this is separate from the display_name of the user.', exampleValue: 'John Doe' } });
export const teamMemberProfileImageUrlSchema = urlSchema.max(1000000).meta({ openapiField: { description: _profileImageUrlDescription('team member'), exampleValue: 'https://example.com/image.jpg' } });

// Contact channels
export const contactChannelIdSchema = yupString().uuid().meta({ openapiField: { description: _idDescription('contact channel'), exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } });
export const contactChannelTypeSchema = yupString().oneOf(['email']).meta({ openapiField: { description: `The type of the contact channel. Currently only "email" is supported.`, exampleValue: 'email' } });
export const contactChannelValueSchema = yupString().when('type', {
  is: 'email',
  then: (schema) => schema.email(),
}).meta({ openapiField: { description: 'The value of the contact channel. For email, this should be a valid email address.', exampleValue: 'johndoe@example.com' } });
export const contactChannelUsedForAuthSchema = yupBoolean().meta({ openapiField: { description: 'Whether the contact channel is used for authentication. If this is set to `true`, the user will be able to sign in with the contact channel with password or OTP.', exampleValue: true } });
export const contactChannelIsVerifiedSchema = yupBoolean().meta({ openapiField: { description: 'Whether the contact channel has been verified. If this is set to `true`, the contact channel has been verified to belong to the user.', exampleValue: true } });
export const contactChannelIsPrimarySchema = yupBoolean().meta({ openapiField: { description: 'Whether the contact channel is the primary contact channel. If this is set to `true`, it will be used for authentication and notifications by default.', exampleValue: true } });

// OAuth providers
export const oauthProviderIdSchema = yupString().uuid().meta({ openapiField: { description: _idDescription('OAuth provider'), exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } });
export const oauthProviderEmailSchema = emailSchema.meta({ openapiField: { description: 'Email of the OAuth provider. This is used to display and identify the OAuth provider in the UI.', exampleValue: 'test@gmail.com' } });
export const oauthProviderTypeSchema = yupString().oneOf(allProviders).meta({ openapiField: { description: `OAuth provider type, one of ${allProviders.map(x => `\`${x}\``).join(', ')}`, exampleValue: 'google' } });
export const oauthProviderAllowSignInSchema = yupBoolean().meta({ openapiField: { description: 'Whether the user can use this OAuth provider to sign in. Only one OAuth provider per type can have this set to `true`.', exampleValue: true } });
export const oauthProviderAllowConnectedAccountsSchema = yupBoolean().meta({ openapiField: { description: 'Whether the user can use this OAuth provider as connected account. Multiple OAuth providers per type can have this set to `true`.', exampleValue: true } });
export const oauthProviderAccountIdSchema = yupString().meta({ openapiField: { description: 'Account ID of the OAuth provider. This uniquely identifies the account on the provider side.', exampleValue: 'google-account-id-12345' } });
export const oauthProviderProviderConfigIdSchema = yupString().meta({ openapiField: { description: 'Provider config ID of the OAuth provider. This uniquely identifies the provider config on config.json file', exampleValue: 'google' } });

// Headers
export const basicAuthorizationHeaderSchema = yupString().test('is-basic-authorization-header', 'Authorization header must be in the format "Basic <base64>"', (value) => {
  if (!value) return true;
  return decodeBasicAuthorizationHeader(value) !== null;
});

// Neon integration
export const neonAuthorizationHeaderSchema = basicAuthorizationHeaderSchema.test('is-authorization-header', 'Invalid client_id:client_secret values; did you use the correct values for the integration?', (value) => {
  if (!value) return true;
  const [clientId, clientSecret] = decodeBasicAuthorizationHeader(value) ?? throwErr(`Authz header invalid? This should've been validated by basicAuthorizationHeaderSchema: ${value}`);
  for (const neonClientConfig of JSON.parse(process.env.STACK_INTEGRATION_CLIENTS_CONFIG || '[]')) {
    if (clientId === neonClientConfig.client_id && clientSecret === neonClientConfig.client_secret) return true;
  }
  return false;
});

// Utils
export function yupDefinedWhen<S extends yup.AnyObject>(
  schema: S,
  triggers: Record<string, any>,
): S {
  const entries = Object.entries(triggers);
  return schema.when(entries.map(([key]) => key), {
    is: (...values: any[]) => entries.every(([key, value], index) => value === values[index]),
    then: (schema: S) => schema.defined(),
    otherwise: (schema: S) => schema.optional()
  });
}

export function yupDefinedAndNonEmptyWhen<S extends yup.StringSchema>(
  schema: S,
  triggers: Record<string, any>,
): S {
  const entries = Object.entries(triggers);
  return schema.when(entries.map(([key]) => key), {
    is: (...values: any[]) => entries.every(([key, value], index) => value === values[index]),
    then: (schema: S) => schema.defined().nonEmpty(),
    otherwise: (schema: S) => schema.optional()
  });
}
