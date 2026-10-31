// One position at a time. While a position is open, the scan does not run.
// Only the seat that closed the position frees the book.
export function createBook() {
  let open = null;
  return {
    get open() { return open; },
    get canScan() { return open === null; },
    claim(lead) {
      if (open) throw new Error(`book busy with lead ${open.lead_id}`);
      open = { ...lead, opened_at: Date.now() };
      return open;
    },
    release(leadId, seat) {
      if (!open) return false;
      if (open.lead_id !== leadId) throw new Error(`release mismatch: ${leadId} != ${open.lead_id}`);
      if (seat !== 'EXIT' && seat !== 'RISK') throw new Error(`only EXIT or RISK may free the book (got ${seat})`);
      open = null;
      return true;
    },
  };
}
