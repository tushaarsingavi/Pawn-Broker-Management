'use strict';
/*
 * Interest engine
 * ---------------
 * Rules (as agreed with the shop owner):
 *  - Simple interest, charged monthly: principal x rate% per month.
 *  - A month that has started counts as a full month (minimum 1 month).
 *  - After every 12 months, the interest of that year that is still UNPAID is added
 *    to the principal; the next year's interest is then charged on the new principal.
 *  - One month's interest is deducted up front when the loan is given. It is treated
 *    as an interest payment made on the loan date.
 *  - Part payments are entered by the owner as either 'interest' or 'principal'.
 *    A principal payment lowers the interest base from the NEXT month onward
 *    (the month in progress is already charged in full).
 *
 * All dates are 'YYYY-MM-DD' strings. All money is in rupees, rounded to paise.
 */

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
function pad(n) { return String(n).padStart(2, '0'); }

// Add k months to a date, clamping to the end of shorter months (31 Jan + 1 month = 28/29 Feb)
function addMonths(dateStr, k) {
  const { y, m, d } = parseDate(dateStr);
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * loan: { date, amount, rate, upfront }
 * payments: [{ date, kind: 'interest'|'principal', amount }]  (real payments only)
 * asOf: 'YYYY-MM-DD'
 */
function calculate(loan, payments, asOf) {
  asOf = asOf || todayStr();
  const rate = Number(loan.rate) / 100;

  // Upfront deduction is an interest payment made on the loan date.
  const all = [];
  if (Number(loan.upfront) > 0) all.push({ date: loan.date, kind: 'interest', amount: Number(loan.upfront), advance: true });
  for (const p of payments) {
    if (p.date <= asOf) all.push({ date: p.date, kind: p.kind, amount: Number(p.amount) });
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const interestPays = all.filter(p => p.kind === 'interest');
  const principalPays = all.filter(p => p.kind === 'principal');
  let ip = 0, pp = 0;

  // Number of months charged: month k starts on addMonths(date, k-1); it is charged if
  // that start date is before asOf (month 1 is always charged).
  let months = 1;
  while (addMonths(loan.date, months) < asOf) months++;

  let P = Number(loan.amount);   // current principal (including capitalised interest)
  let I = 0;                     // interest accrued and not yet paid (negative = advance credit)
  let accrued = 0, interestPaid = 0, principalPaid = 0;
  const capitalizations = [];
  const ledger = [];

  const applyInterest = upTo => {
    while (ip < interestPays.length && interestPays[ip].date <= upTo) {
      I = round2(I - interestPays[ip].amount);
      interestPaid = round2(interestPaid + interestPays[ip].amount);
      ip++;
    }
  };
  const applyPrincipal = upTo => {
    while (pp < principalPays.length && principalPays[pp].date <= upTo) {
      const amt = Math.min(principalPays[pp].amount, P);
      P = round2(P - amt);
      principalPaid = round2(principalPaid + amt);
      pp++;
    }
  };

  for (let k = 1; k <= months; k++) {
    const start = addMonths(loan.date, k - 1);
    const end = addMonths(loan.date, k);
    applyPrincipal(start);
    const interest = round2(P * rate);
    const principalAtStart = P;
    I = round2(I + interest);
    accrued = round2(accrued + interest);
    applyInterest(end);
    let capitalized = 0;
    if (k % 12 === 0 && I > 0 && k <= months) {
      // Year complete: unpaid interest of the year is added to principal.
      capitalized = I;
      P = round2(P + I);
      I = 0;
      capitalizations.push({ month: k, amount: capitalized });
    }
    ledger.push({ month: k, from: start, to: end, principalAtStart, interest, capitalized });
  }
  // Anything dated inside the last (current) month, up to asOf
  applyPrincipal(asOf);
  applyInterest(asOf);

  return {
    asOf,
    monthsCharged: months,
    principalOriginal: Number(loan.amount),
    principal: P,
    interestAccrued: accrued,
    interestPaid,
    principalPaid,
    interestDue: I,                       // negative means the customer has paid ahead
    totalDue: round2(P + I),
    capitalizations,
    ledger,
  };
}

module.exports = { calculate, addMonths, round2, todayStr };
