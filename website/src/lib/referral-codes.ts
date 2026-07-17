export type ReferralCode = {
  code: string;
  customerDiscountPercent: number;
  ambassadorName: string;
  ambassadorId: string;
  commissionPercent: number;
  status: "Active" | "Inactive";
  expirationDate: string;
  maxUses: number;
  uses: number;
};

export const demoReferralCodes: ReferralCode[] = [
  {
    code: "VANTA10",
    customerDiscountPercent: 10,
    ambassadorName: "Mina Alvarez",
    ambassadorId: "AMB-101",
    commissionPercent: 8,
    status: "Active",
    expirationDate: "2027-12-31",
    maxUses: 120,
    uses: 34,
  },
  {
    code: "ATHLETE10",
    customerDiscountPercent: 10,
    ambassadorName: "Jon Mercer",
    ambassadorId: "AMB-202",
    commissionPercent: 9,
    status: "Active",
    expirationDate: "2026-12-31",
    maxUses: 80,
    uses: 80,
  },
  {
    code: "RESEARCH15",
    customerDiscountPercent: 15,
    ambassadorName: "Sage Chen",
    ambassadorId: "AMB-303",
    commissionPercent: 11,
    status: "Inactive",
    expirationDate: "2027-06-30",
    maxUses: 50,
    uses: 12,
  },
  {
    code: "EXPIRED10",
    customerDiscountPercent: 10,
    ambassadorName: "Lina Ortiz",
    ambassadorId: "AMB-404",
    commissionPercent: 7,
    status: "Active",
    expirationDate: "2024-01-01",
    maxUses: 100,
    uses: 12,
  },
];
