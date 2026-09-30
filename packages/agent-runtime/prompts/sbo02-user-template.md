={{
`User request:
${$json.chat_input}

Assessment cycle:
${$json.assessment_cycle}

Next mandatory check:
${$json.next_required_check || 'NONE — ALL MANDATORY CHECKS ARE PRESENT'}

Completed mandatory checks:
${JSON.stringify(
  $json.completed_mandatory_checks,
  null,
  2
)}

Pending mandatory checks:
${JSON.stringify(
  $json.pending_mandatory_checks,
  null,
  2
)}

Checks resolved through additional evidence:
${JSON.stringify(
  $json.evidence_resolved_checks,
  null,
  2
)}

Synthetic case context:
${JSON.stringify(
  $json.case_context,
  null,
  2
)}

Existing runtime results:
${JSON.stringify(
  $json.existing_runtime_results,
  null,
  2
)}

Instructions:

- Select only the mandatory Utility Agent tools still required.
- If this is a resumed assessment, begin with next_required_check.
- Do not repeat any PASS or PASS_WITH_FLAG check.
- Stop immediately if a newly called tool returns is_terminal=true.
- Return an evidence-based provisional recommendation after the
  appropriate tool sequence completes.`
}}