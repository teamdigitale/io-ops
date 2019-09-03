import * as t from "io-ts";
import { enumType } from "italia-ts-commons/lib/types";

export enum scopeEnum {
  "NATIONAL" = "NATIONAL",
  "LOCAL" = "LOCAL"
}

// required attributes
const ServiceR = t.interface({
  scope: enumType<scopeEnum>(scopeEnum, "scope")
});

// optional attributes
const ServiceO = t.partial({
  description: t.string,

  web_url: t.string,

  app_ios: t.string,

  app_android: t.string,

  tos_url: t.string,

  privacy_url: t.string,

  address: t.string,

  phone: t.string,

  email: t.string,

  pec: t.string
});

export const ServiceMetadata = t.exact(
  t.intersection([ServiceR, ServiceO], "Service")
);

export type ServiceMetadata = t.TypeOf<typeof ServiceMetadata>;
