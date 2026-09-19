import type { RoleType, Degree } from "@/lib/classify/posting";
import type { CompanyTier } from "@/lib/classify/company";

export const TIER_LABELS: Record<CompanyTier, string> = {
  elite: "Elite",
  hot: "Hot",
  top: "Top",
  startup: "Startup",
  solid: "Solid",
  other: "Other",
};

/** Role types shown as chips. product_pm and other are archived at ingest, so they are not offered. */
export const ROLE_TYPE_LABELS: Partial<Record<RoleType, string>> = {
  swe: "Software",
  ml_ai: "ML / AI",
  data: "Data",
  quant: "Quant",
  it_security: "IT / Security",
  hardware_ee: "Hardware",
  research_science: "Science",
};

export const DEGREE_LABELS: Record<Degree | "unknown", string> = {
  bs: "Bachelor's",
  ms: "Master's",
  phd: "PhD",
  unknown: "Unspecified",
};
