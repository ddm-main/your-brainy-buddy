// Curated list of Indian banks + card-issuer aliases, used by BankPicker.
// Living list — extend as the user names new banks. Case-insensitive dedupe
// happens server-side via the `banks_name_lower_uidx` unique index.

export const INDIAN_BANKS: string[] = [
  // Public sector
  "SBI",
  "Punjab National Bank",
  "Bank of Baroda",
  "Canara Bank",
  "Union Bank of India",
  "Indian Overseas Bank",
  "Central Bank of India",
  "Bank of India",
  "UCO Bank",
  "IDBI Bank",
  "Punjab & Sind Bank",
  "Indian Bank",
  // Private sector
  "HDFC Bank",
  "ICICI Bank",
  "Axis",
  "Kotak Mahindra Bank",
  "Yes Bank",
  "IDFC FIRST",
  "IndusInd",
  "Federal Bank",
  "RBL Bank",
  "DCB Bank",
  "CSB Bank",
  "Karur Vysya Bank",
  "South Indian Bank",
  "J&K Bank",
  "Karnataka Bank",
  "Tamilnad Mercantile Bank",
  "Bandhan Bank",
  // Small finance banks
  "AU Small Finance Bank",
  "Equitas SFB",
  "Ujjivan SFB",
  "Suryoday SFB",
  "Fincare SFB",
  "ESAF SFB",
  "Jana SFB",
  "Utkarsh SFB",
  // Foreign banks operating in India
  "HSBC",
  "Standard Chartered",
  "Citi",
  "Deutsche Bank",
  "DBS Bank",
  // Card-issuer / co-brand aliases (kept distinct because statements arrive
  // from different sender domains and often have their own PDF layouts).
  "Amazon Pay ICICI",
  "Airtel Axis",
  "Flipkart Axis",
  "Tata Neu HDFC",
  "SBI Card",
  "American Express",
];
