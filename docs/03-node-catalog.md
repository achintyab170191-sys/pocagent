# n8n node catalog

Every exported node is catalogued below. Parameter and code-node details are retained in `artifacts/source-node-catalog.json` to keep this review document readable. Target module / test / parity status for each node is in docs/05.

| Workflow | Node ID | Node name | Node type | Table / dependency |
| --- | --- | --- | --- | --- |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `82d1ddcf-8478-4864-805d-471b886b4c92` | Agentic Chat | `@n8n/n8n-nodes-langchain.chatTrigger` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `39adf6e4-91f9-4387-b342-7649ec07b7c5` | Resolve Case Request | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `6562f98d-b5f3-470d-b9d2-a39818d75f06` | Prepare Invalid Request Response | `n8n-nodes-base.set` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `38e615df-8807-4a48-bbcf-6011e8c92a53` | Get Case Context | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `441d5328-c5fa-46c5-9d16-def58f1d5a1a` | Check Case Exists | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c4635156-49f5-4072-8daa-88257541b2f8` | Case Exists? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `32e295ba-f3cd-4e30-a5fe-b72d5ab3469b` | Case ID Present? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `5a1c6e17-a432-49f1-ae1c-14f416d7b320` | Prepare Case Not Found Response | `n8n-nodes-base.set` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `6f4b3284-1a29-42f2-ba65-1de6008b0178` | Reset Runtime Utility Results | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `47f34172-413e-4bd3-b59d-24c6b4f14a1b` | Prepare Agent Context | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `27f89f90-7ad1-4dbe-a506-90653d277581` | SBO.02 Agentic Reasoning Super Agent | `@n8n/n8n-nodes-langchain.agent` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a217a6c0-5c18-4ae4-b4f2-18e561ea69c5` | OpenAI Model - Agent Reasoning | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `065357f4-4836-43fe-9a4e-1fee9ba7d92f` | Tool - Business Validation | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a73e3127-345f-41cd-a06a-1cd952d0a400` | Tool - Document Checks | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f01b80e2-2dc3-451a-b887-b25f0c06fc9f` | Tool - Identity Validation | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `2f4bfa89-2d82-42ce-9996-70850f7b8c34` | Tool - Authority Validation | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `fe08fd53-d8d8-46e3-818c-cc1daad3925f` | Tool - System Data Check | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `5ad91a34-b07f-4a74-817d-d85a58df7b41` | Tool - Financial Check | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c44fecfc-f287-4272-900f-c38485aa2d35` | Tool - Final Verification | `@n8n/n8n-nodes-langchain.toolWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `cff49719-949c-42eb-bc22-c39afaa15748` | Prepare Parsing Input | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `da28b575-83bd-4a71-840c-2e4a545a01d1` | Structure Agent Recommendation | `@n8n/n8n-nodes-langchain.chainLlm` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `08339bff-6278-4ef6-b6a1-b8276ccca6b1` | OpenAI Model - Output Structuring | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `92ede629-9061-4f5c-953a-41d31421fd0f` | Structured Output Parser | `@n8n/n8n-nodes-langchain.outputParserStructured` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f70e9ebc-1861-4c87-b2a9-9eed89d9f110` | Normalise Provisional Recommendation | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `81615d45-38ef-4a20-be41-3b721c7a36c3` | Run Governed Runtime Finalizer | `n8n-nodes-base.executeWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `70d3a3d9-a970-438c-859a-06093e1c0326` | Prepare Runtime Finalization Input | `n8n-nodes-base.set` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `ea5b58e3-03ab-423f-b907-555abaadd0c6` | Build Chat Response | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `489901aa-45a5-4f1a-99e8-968cff9cf0aa` | Auto-fix Recommendation Format | `@n8n/n8n-nodes-langchain.outputParserAutofixing` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f6cf4b5c-04cc-4017-be9c-e1065ffeb5f8` | OpenAI Model - Parser Repair | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a5969c47-cf76-4709-a682-aedb6f74468e` | Conversation Memory | `@n8n/n8n-nodes-langchain.memoryBufferWindow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `b1026749-6dc2-49bd-a577-1317ea2f414b` | Final Chat Response | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `26a22248-e199-4cbe-bfcc-ad0ac491d245` | Classify Continuation Requirement | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c037cd55-1808-4e70-b89e-640ba69b7a1e` | Customer Evidence Required? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `3cbeb6ba-dcec-40de-9ed9-3b33aee159f1` | Create Evidence Request | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `993e04a9-b03f-4cc7-b518-058c6052e069` | Upsert row(s) | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `e2abe43c-0f48-4a73-a6e9-499b5ff3d659` | Update Case to Waiting for Evidence | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a4384d78-5471-4492-9db5-803b2e791d86` | Select Evidence Channel | `n8n-nodes-base.switch` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `1ea462bb-9f84-40bc-9ec0-973ed1c88b7c` | Ask Customer for Evidence Method | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `02e34050-ac01-4e50-8332-455d6aced929` | Normalise Evidence Method | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `ecdbb965-0e36-4cfe-9448-b5871e2a805f` | Evidence Method Valid? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `b0be0e92-10f7-4f17-9f76-39eca2ceef42` | Ask Evidence Method Again | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f862473f-719d-448e-9b16-778c5953960e` | Normalise Retry Method | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `78655667-b5ba-4232-b31a-1cf3a1f98818` | Retry Method Valid? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `4b3887f0-7705-47d4-bcf9-bdb49eea8fe9` | Send Method Selection Failed | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `4bb38e18-5fb5-49c0-bbc7-62ded7b907c6` | Route Selected Method | `n8n-nodes-base.switch` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a88ff71d-db64-496d-a4a8-77a851ac225b` | Ask for Text Evidence | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `512b0230-e7e6-467a-bf16-844f386e0087` | Normalise Customer Text Evidence | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `78193810-9d8d-474c-aef2-1625e986537d` | Customer Cancelled | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `75b0e274-82bc-4e57-9f49-4e0ce2432d8a` | Cancel Evidence Request | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `1245c7de-46fe-46c8-bc51-b3d6655baf31` | Send Cancellation Message | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f7dec9c0-40f7-4019-863a-b199601e4121` | Text Evidence Received? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a9de1f82-2e8f-4a53-988d-8b3adfdc9586` | Ask for Text Evidence Again | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `2c762273-2996-4b40-b634-286361088235` | Prepare Text Evidence Record | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `da90f617-4a7d-4fa6-9933-97b54b3a49c1` | Store Text Evidence | `n8n-nodes-base.dataTable` | dt_case_evidence |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `4979711c-abc9-46ed-b3c2-5f1c50ad57e1` | Mark Text Evidence Received | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c3820b50-0545-4bd5-af28-cb9c3fc4ffed` | Audit Text Evidence Received | `n8n-nodes-base.dataTable` | dt_audit_events |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `f1ab76ce-e27f-4fa3-8e10-fb9630207a84` | Build Evidence Upload Link | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `aa9837cb-da36-4312-a016-55bf213e72f8` | Ask for Evidence Upload | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `17d20a38-6d12-4605-b503-c27a2641b65d` | Customer Cancelled Upload? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `7b9bbe1d-5268-43c6-848c-53d66736f783` | Cancel Upload Request | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `e107c901-4182-44a9-b546-78d8b5c27d4b` | Update Cancelled Case | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `8d59af61-1cf3-4cf2-83dc-77b2757efa12` | Normalise Upload Reply | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `6a10611c-2874-41cd-8a5a-281fd94ac82c` | Audit Upload Cancellation | `n8n-nodes-base.dataTable` | dt_audit_events |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `10b314aa-1e4c-4488-b88d-5c5f0693f486` | Send Upload Cancelled | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c37f62e2-4143-45f7-95ab-2d283baadece` | Get Uploaded Evidence | `n8n-nodes-base.dataTable` | dt_case_evidence |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `53430133-7f8a-41ca-bc96-d9b9b630f5cc` | Evaluate Upload Availability | `n8n-nodes-base.code` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `69315c48-0ed0-4ad8-9161-e0f5a5ba1129` | Evidence Available? | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `6dcc50ea-923b-481b-b5ba-b6694768e6a6` | Ask Customer to Complete Upload | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `b12fce18-909c-4eed-929d-4135e6c02cf9` | Resolve Customer Evidence | `n8n-nodes-base.executeWorkflow` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `4923a937-3393-4dc7-a023-922a9b9db013` | Update row(s) | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `7effc652-1585-4e00-88af-b1f45ec3d065` | Send Evidence Accepted Message | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `133edf3a-d3d1-42a6-b610-350d41f82682` | Route Evidence Resolution | `n8n-nodes-base.switch` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `1307efe9-6332-4f8a-832c-c00415c59074` | If | `n8n-nodes-base.if` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `ab96fb87-fa02-42e9-81c1-35a024b33de9` | Explain Remaining Evidence Gap | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `74f0b212-50f4-4523-a583-d34b2553299f` | Create Evidence Review After Max Attempts | `n8n-nodes-base.dataTable` | dt_human_reviews |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `8480b9e4-5364-4d1b-b481-1d7ed0afa908` | Update Case After Evidence Escalation | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `b21ddd9a-0e69-43b0-908e-dacac6b17e2f` | Send Evidence Escalation Message | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `c487a671-8267-49cc-834e-c0c7e5154de8` | Audit Evidence Escalation | `n8n-nodes-base.dataTable` | dt_audit_events |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `db0ba1f8-c8a1-4a6d-8b8e-edd42fd94279` | Create Contradictory Evidence Review | `n8n-nodes-base.dataTable` | dt_human_reviews |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `11f8e4b1-fb05-4650-90ea-3ecdde297a9d` | Update Contradictory Evidence Case | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `1369ac89-0b10-49ea-bb62-b262d4fbbf85` | Audit Contradictory Evidence | `n8n-nodes-base.dataTable` | dt_audit_events |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `8539eb96-7f4b-4cec-97dd-79b8f4fa43e9` | Send Contradictory Evidence Message | `@n8n/n8n-nodes-langchain.chat` | — |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `a53879d0-087f-4e58-8b37-66ec5fda6b88` | Get Existing Runtime Results | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 03 - SBO.02 - Agentic Reasoning Orchestrator.json | `52de6bd6-df38-4c72-9814-9ad99a81f660` | Compare Agent and Governed Outcome | `n8n-nodes-base.code` | — |
| 05 - SBO.05 - Document Checks.json | `1d4e4bd7-cdc7-4e8a-b474-da099b89f182` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 05 - SBO.05 - Document Checks.json | `bf691cd6-e847-4578-b74a-705b8fe73819` | Build Utility Result | `n8n-nodes-base.code` | — |
| 05 - SBO.05 - Document Checks.json | `ab922b5f-bc97-4c51-9514-bd1d968e136d` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 05 - SBO.05 - Document Checks.json | `98006e4a-7b8c-4afc-bb3e-0fdf4b032b59` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 05 - SBO.05 - Document Checks.json | `86677e1d-79c4-43f7-9343-fe15472fe4db` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 05 - SBO.05 - Document Checks.json | `080df1cf-246d-4dfa-91e7-205eac4610e3` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 05 - SBO.05 - Document Checks.json | `0c6b36b7-a58b-4229-aede-fc92aa7b65dd` | Return Utility Result | `n8n-nodes-base.code` | — |
| 06 - SBO.06 - Business Validation.json | `6acc30c5-2db7-4e61-87ad-ff65afab46a1` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 06 - SBO.06 - Business Validation.json | `b94e32d5-05cf-467d-b3ea-40b56de8f404` | Build Utility Result | `n8n-nodes-base.code` | — |
| 06 - SBO.06 - Business Validation.json | `dbf67107-8532-4dae-b267-b5db08f83940` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 06 - SBO.06 - Business Validation.json | `bb1e27de-3dd1-49bb-a8ab-fd07a696d829` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 06 - SBO.06 - Business Validation.json | `4c643acd-30ab-4a3d-9545-937a092ce729` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 06 - SBO.06 - Business Validation.json | `6e412c33-1c6e-44d5-b2d3-56805266f8a2` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 06 - SBO.06 - Business Validation.json | `8911209c-4c48-40e7-9f71-fa925e89cf8d` | Return Utility Result | `n8n-nodes-base.code` | — |
| 07A - SBO.07 - Identity Validation.json | `193161bc-7021-4540-8ece-ceeedd04212b` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 07A - SBO.07 - Identity Validation.json | `e6a8364c-8ef2-49b3-829b-a93236abd15e` | Build Utility Result | `n8n-nodes-base.code` | — |
| 07A - SBO.07 - Identity Validation.json | `6d58437a-d695-47f4-bb20-f6b398922e4d` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 07A - SBO.07 - Identity Validation.json | `ff7b04d1-55c3-45ff-92f7-3f11a269bf1c` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 07A - SBO.07 - Identity Validation.json | `038c555a-b030-4e03-9ae5-53a8b1d9d6fa` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 07A - SBO.07 - Identity Validation.json | `89c308d3-a1de-404b-88c6-a71db908bf57` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 07A - SBO.07 - Identity Validation.json | `ace2046c-ecb3-4a72-9453-71c4ca0770ad` | Return Utility Result | `n8n-nodes-base.code` | — |
| 07B - SBO.07 - Authority Validation.json | `5c0c51b1-9bd3-465c-8ec6-634705bddfa5` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 07B - SBO.07 - Authority Validation.json | `5fda9513-51e8-4e4a-9152-5e847f84aa15` | Build Utility Result | `n8n-nodes-base.code` | — |
| 07B - SBO.07 - Authority Validation.json | `52f03db4-3a48-4fa1-90b5-eb313b500be0` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 07B - SBO.07 - Authority Validation.json | `039f6770-c95a-4e3b-ac8c-9ea30ea5243a` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 07B - SBO.07 - Authority Validation.json | `be449a84-336f-4d8a-9c0c-2f97fb9a298e` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 07B - SBO.07 - Authority Validation.json | `6c40d757-985c-40cd-8e76-b3785977721f` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 07B - SBO.07 - Authority Validation.json | `01d8d80f-b679-468a-875b-92f5f797085e` | Return Utility Result | `n8n-nodes-base.code` | — |
| 09 - SBO.09 - Financial Check.json | `586c8de4-a1d1-417c-b4dc-9b9ef0582f87` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 09 - SBO.09 - Financial Check.json | `f4f2ba70-934b-43ab-afeb-02805973619e` | Build Utility Result | `n8n-nodes-base.code` | — |
| 09 - SBO.09 - Financial Check.json | `fe4dc456-6b60-4e54-88a3-83d1d959cae9` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 09 - SBO.09 - Financial Check.json | `f5c76eab-7a3d-46a0-a8c8-64efec18b371` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 09 - SBO.09 - Financial Check.json | `46e7bd86-93ed-4307-8ac6-b976d1bb8b50` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 09 - SBO.09 - Financial Check.json | `6299b0c5-d1f4-42f0-ae3b-f3bce3d0d26d` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 09 - SBO.09 - Financial Check.json | `f77571b4-e65d-4e49-aac4-65437be2bb84` | Return Utility Result | `n8n-nodes-base.code` | — |
| 10 - SBO.10 - Final Verification.json | `ba8d9657-9b44-45de-9392-db762beaa90d` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 10 - SBO.10 - Final Verification.json | `a23910bd-2767-4cc0-aa9d-7a65ae64c24f` | Build Utility Result | `n8n-nodes-base.code` | — |
| 10 - SBO.10 - Final Verification.json | `75df4ea0-c34b-4346-884d-faadceb09423` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 10 - SBO.10 - Final Verification.json | `1bc3e32f-ce6a-4034-8f0d-610cb2f8b351` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 10 - SBO.10 - Final Verification.json | `469b484c-691f-4113-a1b7-2ab9e6880305` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 10 - SBO.10 - Final Verification.json | `e763635c-86fc-4725-b8a5-aa6bab3f681d` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 10 - SBO.10 - Final Verification.json | `95b03edf-1968-4ee1-99a0-45b9515cb54c` | Return Utility Result | `n8n-nodes-base.code` | — |
| 12 - SBO.12 - System Data Check.json | `e3927f6f-c6ac-4117-8461-d048400d494a` | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 12 - SBO.12 - System Data Check.json | `0aba42e8-0fbc-49b0-a812-56f6df6ec588` | Build Utility Result | `n8n-nodes-base.code` | — |
| 12 - SBO.12 - System Data Check.json | `cf662c44-83c6-4767-8ab7-b6a9e18a0ed2` | Store Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 12 - SBO.12 - System Data Check.json | `514825b1-605e-4093-b25c-9960d8fc2696` | Get Mock Utility Result | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 12 - SBO.12 - System Data Check.json | `c33eba36-fb38-49f7-be83-6baa092a54bf` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 12 - SBO.12 - System Data Check.json | `19065a7c-b738-412a-afa9-7263765dcf99` | Audit Utility Check | `n8n-nodes-base.dataTable` | dt_audit_events |
| 12 - SBO.12 - System Data Check.json | `b0a4383c-4ce2-4c2c-b96b-daef1da41551` | Return Utility Result | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `70251e83-7721-4753-90c6-e2ba3487cdb6` | Get Case | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 90 - Finalize Decision.json | `aa677402-3e63-4d80-9d4a-ab294a0256cc` | Get Decision Rules | `n8n-nodes-base.dataTable` | dt_decision_rules |
| 90 - Finalize Decision.json | `6f160790-0a5d-4473-ba98-458f772ec836` | Receive Finalization Request | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 90 - Finalize Decision.json | `3c54f4bb-a1c8-43c1-9b77-1afd77f86861` | When clicking ‘Execute workflow’ | `n8n-nodes-base.manualTrigger` | — |
| 90 - Finalize Decision.json | `7115939e-6641-495c-b29e-7d8987aa928f` | Edit Fields | `n8n-nodes-base.set` | — |
| 90 - Finalize Decision.json | `efcfc8ab-2dfc-4bb9-8a60-c0c48a4bf795` | Call '90 - Finalize Decision' | `n8n-nodes-base.executeWorkflow` | — |
| 90 - Finalize Decision.json | `bb9841fc-35ba-4eb5-8434-1e52f47fe4c4` | Get Communication Template | `n8n-nodes-base.dataTable` | dt_communication_templates |
| 90 - Finalize Decision.json | `f310bebd-9513-490a-a644-349651d8245b` | Build Communication | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `fdf42591-800c-490a-bcf3-4c7790c43d81` | Determine Final Decision | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `5176cfe2-ff3a-4c96-a78d-c0f5f9aaed56` | Store Final Decision | `n8n-nodes-base.dataTable` | dt_decisions |
| 90 - Finalize Decision.json | `3f6da5e9-1ca0-40f3-9a7c-8bd86b26a49c` | Return Final Package | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `804b2602-93db-486d-92a6-677fe541a430` | Get Mock Utility Results | `n8n-nodes-base.dataTable` | dt_mock_utility_results |
| 90 - Finalize Decision.json | `7f4a0d9d-5efb-41bc-a064-136d0578f4d9` | Store Initial Communication | `n8n-nodes-base.dataTable` | dt_communications |
| 90 - Finalize Decision.json | `a53c6471-55b3-444e-8d5a-b6c2fb34665c` | Prepare Runtime Case Record | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `c30b4726-83d3-489c-ab62-509b4fa7f6a6` | Upsert Runtime Case | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 90 - Finalize Decision.json | `5ebdcd5e-ded7-4957-852c-c930791dd5b5` | Prepare Result Source | `n8n-nodes-base.set` | — |
| 90 - Finalize Decision.json | `87244375-792b-497b-a501-b95e6f2b12c2` | Select Result Source | `n8n-nodes-base.switch` | — |
| 90 - Finalize Decision.json | `4a01d31c-ea6b-4489-b370-eb3174ef0797` | Package Mock Utility Results | `n8n-nodes-base.code` | — |
| 90 - Finalize Decision.json | `450f1104-40bd-4f62-976f-51c734952a94` | Get Runtime Utility Results | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 90 - Finalize Decision.json | `b8c944d7-3c8c-445d-9e42-3a999e35539b` | Package Runtime Utility Results | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `bee7b1d5-21a4-4ada-8d57-d5380c298847` | Open Review | `n8n-nodes-base.formTrigger` | — |
| 91 - Human Review Portal.json | `31f501ab-180e-4011-9950-e9c9fb52d383` | Get Review Record | `n8n-nodes-base.dataTable` | dt_human_reviews |
| 91 - Human Review Portal.json | `36bb34a8-4881-41db-9291-bd446bec72d0` | Check Review Status | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `d683395c-1be9-47ec-9959-365a845a9215` | Review Found? | `n8n-nodes-base.if` | — |
| 91 - Human Review Portal.json | `d21be6d3-0c55-448f-b188-f0d39538d1aa` | Review Not Found | `n8n-nodes-base.form` | — |
| 91 - Human Review Portal.json | `63e0dfe6-6650-4edc-a6a8-1305ae93b0a3` | Review Open? | `n8n-nodes-base.if` | — |
| 91 - Human Review Portal.json | `b7d4b25b-4743-4e93-a309-8f5a4c45eb5f` | Show Review Already Completed | `n8n-nodes-base.form` | — |
| 91 - Human Review Portal.json | `2f95851c-f699-44f1-ab36-f809b33b075f` | Get Decision Record | `n8n-nodes-base.dataTable` | dt_decisions |
| 91 - Human Review Portal.json | `989db4d1-c86b-4467-a359-49a9bed20cab` | Get Case Record | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 91 - Human Review Portal.json | `b7900c12-8eab-4ad8-b91d-951436fbc036` | Prepare Review Package | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `bca74607-adc1-4583-a7d6-90472524e995` | Form | `n8n-nodes-base.form` | — |
| 91 - Human Review Portal.json | `1b3a1030-8f23-49c5-b8e2-31cf4c96b5eb` | Validate Reviewer Submission | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `492fd776-ccf4-46a4-affc-75c71e263fdd` | Update Review Record | `n8n-nodes-base.dataTable` | dt_human_reviews |
| 91 - Human Review Portal.json | `92111d7d-4698-45aa-8d00-ad2f5772b267` | Update Final Decision | `n8n-nodes-base.dataTable` | dt_decisions |
| 91 - Human Review Portal.json | `1ed0661c-5d73-4b36-8399-75b45eaaaf48` | Create Review Audit Event | `n8n-nodes-base.dataTable` | dt_audit_events |
| 91 - Human Review Portal.json | `bf749c60-8d32-454c-ab63-34c3c0dbf19f` | Restore Reviewed Package | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `83817c5d-d03a-4a68-97e3-72fdd3fa6e51` | Show Review Completed | `n8n-nodes-base.form` | — |
| 91 - Human Review Portal.json | `64114d97-7f3a-4a50-b3af-2b075aa90053` | Get Human Review Communication Template | `n8n-nodes-base.dataTable` | dt_communication_templates |
| 91 - Human Review Portal.json | `5b42ea33-110c-4b1a-a793-83c2bd77a650` | Build Human Review Communication | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `5898f9bc-4ae2-40e5-9239-0a271a9cabaf` | Store Human Review Communication | `n8n-nodes-base.dataTable` | dt_communications |
| 91 - Human Review Portal.json | `ab7764cc-211e-4f2c-a32d-f553c079bb5f` | Prepare Reviewed Runtime Case | `n8n-nodes-base.code` | — |
| 91 - Human Review Portal.json | `1b3c4f0b-eabc-4c03-b4c9-d44dd09d4608` | Update Runtime Case After Review | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 92 - Resubmission Portal.json | `061929f1-0084-4766-9022-a6f03c525177` | Open Resubmission | `n8n-nodes-base.formTrigger` | — |
| 92 - Resubmission Portal.json | `feb00ac8-9351-41f5-9b7a-9bf40b4847e2` | Get Original Decision | `n8n-nodes-base.dataTable` | dt_decisions |
| 92 - Resubmission Portal.json | `886c32c9-cf3f-4fb1-b23f-73186433c8e5` | Check Resubmission Eligibility | `n8n-nodes-base.code` | — |
| 92 - Resubmission Portal.json | `516c699b-9886-473a-b5ac-f7ed00b06aa3` | Resubmission Eligible? | `n8n-nodes-base.if` | — |
| 92 - Resubmission Portal.json | `6af4634c-a89e-4f99-9c89-e6b5bff47253` | Show Resubmission Not Allowed | `n8n-nodes-base.form` | — |
| 92 - Resubmission Portal.json | `11dbb7f4-016f-4d3d-9c57-79e8c328334e` | Get Original Case | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 92 - Resubmission Portal.json | `4404749f-3632-42e7-9a33-8978f1674234` | Get Revised Case | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 92 - Resubmission Portal.json | `fcc6824d-29f5-4418-851b-f99fc2c05edd` | Validate Version Relationship | `n8n-nodes-base.code` | — |
| 92 - Resubmission Portal.json | `b0a20910-b4e8-43a1-b569-dd18693950fc` | Version Relationship Valid? | `n8n-nodes-base.if` | — |
| 92 - Resubmission Portal.json | `98962993-689a-4fb3-8e50-111b791f72db` | Show Invalid Revised Version | `n8n-nodes-base.form` | — |
| 92 - Resubmission Portal.json | `6f341726-0c89-4d4a-afee-6da620047440` | Prepare Revised Assessment | `n8n-nodes-base.set` | — |
| 92 - Resubmission Portal.json | `aa094c88-18a4-475b-ad3f-c4a6a0028890` | Run Revised SBO.02 Assessment | `n8n-nodes-base.executeWorkflow` | — |
| 92 - Resubmission Portal.json | `0487555d-7cdf-4636-82e7-5ac568315b87` | Prepare Original Case Supersede Update | `n8n-nodes-base.code` | — |
| 92 - Resubmission Portal.json | `0616e417-6355-4ca8-a48b-b2f24cd42a7f` | Mark Original Case Superseded | `n8n-nodes-base.dataTable` | dt_cases_runtime |
| 92 - Resubmission Portal.json | `b0e2b9e1-5b63-422c-b134-3ec5651c1743` | Create Resubmission Audit Event | `n8n-nodes-base.dataTable` | dt_audit_events |
| 92 - Resubmission Portal.json | `48db3fd5-9e5e-4245-9643-423609a78319` | Restore Revised Decision | `n8n-nodes-base.code` | — |
| 92 - Resubmission Portal.json | `b0fc699f-6b56-4841-b7fc-7a4a74ce2766` | Show Resubmission Result | `n8n-nodes-base.form` | — |
| 95 - Evidence Resolution Utility.json | `e2e5a7a5-0f06-4930-a781-f799a81c1a38` | Receive Evidence Resolution Request | `n8n-nodes-base.executeWorkflowTrigger` | — |
| 95 - Evidence Resolution Utility.json | `7c69ba8e-e581-4f90-bc21-2663924a32e3` | Get Evidence Request | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 95 - Evidence Resolution Utility.json | `dc4bd876-f8b0-4f40-aec6-c5b7ed283ead` | Check Resolution Request | `n8n-nodes-base.code` | — |
| 95 - Evidence Resolution Utility.json | `49bc123a-68bf-4abb-977b-68f4aea33d8b` | Resolution Request Valid? | `n8n-nodes-base.if` | — |
| 95 - Evidence Resolution Utility.json | `7544b5b1-8338-41f1-ae5c-65b766c164a1` | Stop Invalid Resolution Request | `n8n-nodes-base.stopAndError` | — |
| 95 - Evidence Resolution Utility.json | `cf34cfd8-fc2e-4d2b-96f0-07073255763a` | Get Evidence Records | `n8n-nodes-base.dataTable` | dt_case_evidence |
| 95 - Evidence Resolution Utility.json | `16fdde01-29d8-48ac-891d-0c4285474ac5` | Check Evidence Records | `n8n-nodes-base.code` | — |
| 95 - Evidence Resolution Utility.json | `ebf3551f-2bc9-452d-bab5-60fc2b9b4863` | Evidence Records Exist? | `n8n-nodes-base.if` | — |
| 95 - Evidence Resolution Utility.json | `197154ed-de70-4472-bf9d-18d7870d0e52` | Stop and Error | `n8n-nodes-base.stopAndError` | — |
| 95 - Evidence Resolution Utility.json | `08a50190-61c1-4541-adff-19cb633a20e3` | Get Evidence Case | `n8n-nodes-base.dataTable` | dt_synthetic_cases |
| 95 - Evidence Resolution Utility.json | `f2ff99d1-f428-4714-a3bc-141f37354b82` | Prepare Resolution Context | `n8n-nodes-base.code` | — |
| 95 - Evidence Resolution Utility.json | `f02bfc8f-3ac8-45d6-98c0-5f2bb854c1a2` | Resolve Additional Evidence | `@n8n/n8n-nodes-langchain.chainLlm` | — |
| 95 - Evidence Resolution Utility.json | `49a4a0d6-d94f-4a7c-9605-dcf5055a8352` | OpenAI Model - Evidence Resolution | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | — |
| 95 - Evidence Resolution Utility.json | `324d647b-90a6-4477-aa22-c4060e6193a3` | Auto-fix Evidence Resolution Output | `@n8n/n8n-nodes-langchain.outputParserAutofixing` | — |
| 95 - Evidence Resolution Utility.json | `14937987-cce9-482c-b218-aeeaa6c04625` | Structured Evidence Resolution Parser | `@n8n/n8n-nodes-langchain.outputParserStructured` | — |
| 95 - Evidence Resolution Utility.json | `4579036f-1a44-4e26-bf92-ab49011bcb60` | OpenAI Model - Evidence Parser Repair | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | — |
| 95 - Evidence Resolution Utility.json | `d2ce85bd-5ee4-42f6-936f-ad5ef1b71d96` | Build Resolved Utility Result | `n8n-nodes-base.code` | — |
| 95 - Evidence Resolution Utility.json | `aa9b84fc-dc4b-460c-ae50-573438df6fa4` | Store Resolved Utility Result | `n8n-nodes-base.dataTable` | dt_utility_results_runtime |
| 95 - Evidence Resolution Utility.json | `9a6896f6-69d1-4f18-b7f3-1fc05c7dd0c8` | Update Evidence Record Status | `n8n-nodes-base.dataTable` | dt_case_evidence |
| 95 - Evidence Resolution Utility.json | `f05544a2-90fa-4b4b-a6d3-be95bb8e9f7c` | Update Evidence Request | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 95 - Evidence Resolution Utility.json | `108763eb-cc9f-4209-85b8-621e3f63a90e` | Audit Evidence Resolution | `n8n-nodes-base.dataTable` | dt_audit_events |
| 95 - Evidence Resolution Utility.json | `75021e68-10e5-421d-bc5e-895963c23758` | Return Resolution Result | `n8n-nodes-base.code` | — |
| 96 - Customer Evidence Upload Portal.json | `2c8835b3-eae4-4124-b501-59253b6d5e81` | Open Evidence Upload | `n8n-nodes-base.formTrigger` | — |
| 96 - Customer Evidence Upload Portal.json | `f5a98d23-47bb-41dc-ae78-6578968e5fd5` | Get Evidence Request | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 96 - Customer Evidence Upload Portal.json | `d56bd070-9892-4aef-9fcd-9332d2140b61` | Validate Evidence Request | `n8n-nodes-base.code` | — |
| 96 - Customer Evidence Upload Portal.json | `a75135bf-4e31-4eba-9e27-843241d2e948` | Show Upload Not Allowed | `n8n-nodes-base.form` | — |
| 96 - Customer Evidence Upload Portal.json | `b7b5295e-4823-4b36-8d1f-65ada1c07933` | Extract PDF Text | `n8n-nodes-base.extractFromFile` | — |
| 96 - Customer Evidence Upload Portal.json | `84aeac7d-89ed-481f-acfe-6cc86458c67f` | Check Extracted PDF | `n8n-nodes-base.code` | — |
| 96 - Customer Evidence Upload Portal.json | `1b4e53ab-d6f5-4141-a98a-2aee503e4762` | PDF Text Available? | `n8n-nodes-base.if` | — |
| 96 - Customer Evidence Upload Portal.json | `6a950808-11fc-4771-b1f3-39fa2a0a2939` | Show Unreadable PDF | `n8n-nodes-base.form` | — |
| 96 - Customer Evidence Upload Portal.json | `fbdf24e6-160a-47d4-9ec3-50eb601681e0` | Prepare Uploaded Evidence | `n8n-nodes-base.code` | — |
| 96 - Customer Evidence Upload Portal.json | `3338fc31-15c2-4fb9-acb4-af23f0d24a97` | Store Uploaded Evidence | `n8n-nodes-base.dataTable` | dt_case_evidence |
| 96 - Customer Evidence Upload Portal.json | `3c3a0b16-bf5c-40e7-8243-8c5c3dc99b5f` | Mark Uploaded Evidence Received | `n8n-nodes-base.dataTable` | dt_evidence_requests |
| 96 - Customer Evidence Upload Portal.json | `dedd34bc-6034-49ad-a091-c7200672b215` | Audit Uploaded Evidence Received | `n8n-nodes-base.dataTable` | dt_audit_events |
| 96 - Customer Evidence Upload Portal.json | `5189cb7e-d653-45d5-a3b9-522eb00568db` | Show Upload Completed | `n8n-nodes-base.form` | — |
| 96 - Customer Evidence Upload Portal.json | `c8fc23ee-06d0-4158-b292-fce2b265881d` | Normalise Evidence Upload Input | `n8n-nodes-base.code` | — |
| 96 - Customer Evidence Upload Portal.json | `f524f672-b486-48c0-abd6-87f323358f74` | Request Open? | `n8n-nodes-base.if` | — |