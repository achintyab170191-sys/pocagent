# Source inventory

> **ARCHIVED (docs/09).** This document analyses the earlier n8n export, which the To-Be process diagrams have replaced as the source of truth. It is kept as reference only and is not maintained.

Generated from the immutable root-level n8n JSON exports and CSV Data Table exports. No `source/`, `docs/`, or `samples/` directories were supplied: the artifacts sit in the repository root and are preserved in place, unchanged (verify with `npm run verify:sources`).

## Preservation manifest

| Path | Type | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | JSON | 249558 | `f1be529bcd1f50cde75d0a5b31b6966ae4f68ef8d36be2285c9932a21ad60ec0` |
| 05 - SBO.05 - Document Checks.json | JSON | 20792 | `4c789d3920c8d463ef18bdb0e1c6d1939ca81f6f21291fff80c1c094ad7502b8` |
| 06 - SBO.06 - Business Validation.json | JSON | 20804 | `12732009a44360679919db981fe58f89aaec00362ad42d6d4a9e40b545149c8b` |
| 07A - SBO.07 - Identity Validation.json | JSON | 20805 | `1dea0331dfebbc20aab45d9b3fd14b380c8b7ff038bc1a9a91ebea085d5893ec` |
| 07B - SBO.07 - Authority Validation.json | JSON | 20807 | `a734fcef2984494709a6fee24e7adccfcffd374d2e988e74d87f7e41785e770d` |
| 09 - SBO.09 - Financial Check.json | JSON | 21035 | `c49b1d5f35b1b1d1b29077f53802a9c977e4b740ce66c7a55ea406adc40ef6ee` |
| 10 - SBO.10 - Final Verification.json | JSON | 21041 | `dbb56e1c15b55e7bbf01492f7dd91e85209b4ff7095d513b6b12bb938209e4b9` |
| 12 - SBO.12 - System Data Check.json | JSON | 22517 | `2044ab3e80260f7182bcfac03318850d8d232f06cd648664921b0a4c7daed702` |
| 90 - Finalize Decision.json | JSON | 61840 | `fb64e5d921774c8ecde1d8ef5dc2d90b8a7bb14ca09d436f001d672888f9eb96` |
| 91 - Human Review Portal.json | JSON | 61063 | `4b54bf70a11e483d6d656568471606c7103f81261cebf7d4c9172b24e96b42bf` |
| 92 - Resubmission Portal.json | JSON | 33539 | `a5b867c0d8a21c3684200a07eb15d4ee20f212c5501eba69097be762e3042b6e` |
| 95 - Evidence Resolution Utility.json | JSON | 59764 | `66c55d8b30ef58887e273eaa0cb979ca1fba22598eee48c29781dd69c4b6a06f` |
| 96 - Customer Evidence Upload Portal.json | JSON | 39944 | `86545ad006a437b341c21d0112a78e51c94ed7de77e56ad72d573cf62b5e83b8` |
| dt_audit_events.csv | CSV | 632049 | `115cd0d605dc43a952cbb7649f804e1cb2dbe6a2d0558bd694d67c80293b3a45` |
| dt_business_register.csv | CSV | 2503 | `f4df0dfd11a8697e601072fde4d562cf65bab21b747e68867259025bda216c64` |
| dt_cases_runtime.csv | CSV | 3476 | `f7732485519d28685d896f8e02b1cf5742f710f932f3bbf308fa8a9730b3e8b9` |
| dt_case_evidence.csv | CSV | 3915 | `7931c16b97e3dedfac0c505fd10d444c1377866d575af24b94b7cb43cb2832c8` |
| dt_communications.csv | CSV | 4773 | `79e09f445fd050896661248915dcf195e985af2abff7039b4e844dbf7be95328` |
| dt_communication_templates.csv | CSV | 2216 | `5b8f301ea866b0630cb2a6a82a977dc435ef283212a2cecefca2ea84d58c541d` |
| dt_country_requirements.csv | CSV | 862 | `695caa00a080abcdef4733b99bb2910a8e435daaf376833a454aecca167ac239` |
| dt_crm_accounts.csv | CSV | 2112 | `dc36f51758d6c5d417fd89a34a954dd4de2cbe2bc8193f08734ac9bade5cbca7` |
| dt_decisions.csv | CSV | 51722 | `03a50d5f0eac65e7318a54d8c56ce2fab77a564de762500aac45d7d2feb1e9ed` |
| dt_decision_rules.csv | CSV | 9740 | `138739ebb31a6d9e9f5a55171be6cc8e1fa7e956d6367619a908a85321d16230` |
| dt_documents_index.csv | CSV | 13206 | `99cd1539665ac9535bfa8eb01102c3656278ba2adab2f8bf639adec48109c1a7` |
| dt_evidence_requests.csv | CSV | 1048 | `a254d722b0e1b55de163c245ffeff40ac841f7cc3af3c08f38f01c9efe68c86b` |
| dt_financial_records.csv | CSV | 1551 | `225bf0aa46af8a5d765242aaadc63b50787de5f0284e5479447e75b4d03f620d` |
| dt_human_reviews.csv | CSV | 395 | `28e256c831335a3f69d8b297c98adf56096da1d72c31b8737f5467249fbe1d67` |
| dt_mock_utility_results.csv | CSV | 21437 | `fa855250bf94debd2d40f3e491ec2094a3a1211e353646372916e2406fa9dad5` |
| dt_process_catalog.csv | CSV | 348 | `a1c95c8af614a0f672aff6467d345f6463f3aaa22d2233198a0804b398b0a7af` |
| dt_reason_codes.csv | CSV | 2375 | `055cefb457ca82cccde642f7a74f71aff113204f07cb22ed206112e31f695e0a` |
| dt_synthetic_cases.csv | CSV | 6113 | `7eda6f03d5aa63d82b3236d4382bd08afd6102da3235e07d152a8c1350593c46` |
| dt_utility_results_runtime.csv | CSV | 5781 | `b626ef0315dbc6c89d41b1324df1dc0dea0303ee99ec21277046fe623f451a32` |

## Workflow inventory

| Source file | Workflow name | Nodes |
| --- | --- | ---: |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | 03 - SBO.02 - Agentic Reasoning Orchestrator | 84 |
| 05 - SBO.05 - Document Checks.json | 05 - SBO.05 - Document Checks | 7 |
| 06 - SBO.06 - Business Validation.json | 06 - SBO.06 - Business Validation | 7 |
| 07A - SBO.07 - Identity Validation.json | 07A - SBO.07 - Identity Validation | 7 |
| 07B - SBO.07 - Authority Validation.json | 07B - SBO.07 - Authority Validation | 7 |
| 09 - SBO.09 - Financial Check.json | 09 - SBO.09 - Financial Check | 7 |
| 10 - SBO.10 - Final Verification.json | 10 - SBO.10 - Final Verification | 7 |
| 12 - SBO.12 - System Data Check.json | 12 - SBO.12 - System Data Check | 7 |
| 90 - Finalize Decision.json | 90 - Finalize Decision | 20 |
| 91 - Human Review Portal.json | 91 - Human Review Portal | 22 |
| 92 - Resubmission Portal.json | 92 - Resubmission Portal | 17 |
| 95 - Evidence Resolution Utility.json | 95 - Evidence Resolution Utility | 22 |
| 96 - Customer Evidence Upload Portal.json | 96 - Customer Evidence Upload Portal | 15 |

## Expected-workflow check

Present: 03, 05, 06, 07A, 07B, 09, 10, 12, 90, 91, 92, 95, 96. **Absent: 93 – Case Status Portal.** Workflow 92 also calls `02 - SBO.02 - Profiling Super Agent`, which is not part of the upload (see docs/07). No workflow was invented for either.

## Data-table inventory

| Export | Rows | Columns | Classification |
| --- | ---: | ---: | --- |
| dt_audit_events.csv | 678 | 14 | Runtime execution history — NOT seed data |
| dt_business_register.csv | 10 | 12 | Static reference fixture (seed) |
| dt_cases_runtime.csv | 11 | 19 | Runtime execution history — NOT seed data |
| dt_case_evidence.csv | 2 | 15 | Runtime execution history — NOT seed data |
| dt_communications.csv | 11 | 11 | Runtime execution history — NOT seed data |
| dt_communication_templates.csv | 5 | 9 | Static reference fixture (seed) |
| dt_country_requirements.csv | 2 | 10 | Static reference fixture (seed) |
| dt_crm_accounts.csv | 11 | 15 | Static reference fixture (seed) |
| dt_decisions.csv | 11 | 16 | Runtime execution history — NOT seed data |
| dt_decision_rules.csv | 27 | 17 | Static reference fixture (seed) |
| dt_documents_index.csv | 33 | 20 | Static reference fixture (seed) |
| dt_evidence_requests.csv | 2 | 17 | Runtime execution history — NOT seed data |
| dt_financial_records.csv | 11 | 13 | Static reference fixture (seed) |
| dt_human_reviews.csv | 2 | 11 | Runtime execution history — NOT seed data |
| dt_mock_utility_results.csv | 77 | 16 | Static reference fixture (seed) |
| dt_process_catalog.csv | 1 | 11 | Static reference fixture (seed) |
| dt_reason_codes.csv | 22 | 5 | Static reference fixture (seed) |
| dt_synthetic_cases.csv | 11 | 17 | Static reference fixture (seed) |
| dt_utility_results_runtime.csv | 12 | 18 | Runtime execution history — NOT seed data |

`dt_mock_utility_results` is keyed by `Case_Run_ID` + `Check_Type` and has no `submission_version`; `dt_utility_results_runtime` carries `case_run_id`, `submission_version` and `check_type`.
The expected tables `Business_Register`, `CRM_Accounts`, `Financial_Records` and `Documents_Index` are exported as `dt_business_register`, `dt_crm_accounts`, `dt_financial_records` and `dt_documents_index`; `dt_country_requirements`, `dt_process_catalog` and `dt_reason_codes` are additional tables not in the expected list.