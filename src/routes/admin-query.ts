import { z } from "zod";

export const listQueryFields = {
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).default(1),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(50)).default(15),
  search: z.string().trim().max(100).default(""),
};

export function literalSearch(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
