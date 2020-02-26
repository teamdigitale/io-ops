/**
 * Do not edit this file it is auto-generated by italia-utils / gen-api-models.
 * See https://github.com/teamdigitale/italia-utils
 */
/* tslint:disable */

import { PatternString } from "italia-ts-commons/lib/strings";
import * as t from "io-ts";

/**
 * Describes a single IP or a range of IPs.
 */

export type CIDR = t.TypeOf<typeof CIDR>;
export const CIDR = PatternString(
  "^([0-9]{1,3}[.]){3}[0-9]{1,3}(/([0-9]|[1-2][0-9]|3[0-2]))?$"
);
