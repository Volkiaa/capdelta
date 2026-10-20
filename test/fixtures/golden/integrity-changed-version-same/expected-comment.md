<!-- capdelta:capability-report:v2 -->
## capdelta dependency review

Review this change: capdelta reports newly gained capabilities.

| Packages | Analyzed | Unavailable | Lockfile skips |
| ---: | ---: | ---: | ---: |
| 1 | 1 | 0 | 0 |

| Critical | High | Medium | Low | Info |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 0 | 0 |

### Findings to review

| Package | Severity | Change | Evidence |
| --- | --- | --- | --- |
| golden&#45;integrity | HIGH | integrity&#45;changed&#45;version&#45;same | node&#95;modules&#47;golden&#45;integrity&#58; 1&#46;0&#46;0 &#45;&#62; 1&#46;0&#46;0 |

### What these mean

- **integrity&#45;changed&#45;version&#45;same**: npm does not let a published version change its contents&#44; so different bytes under the same version mean the lockfile entry&#44; its resolved URL&#44; or the registry changed&#46; Compare the old and new resolved and integrity fields&#44; find the commit that changed them&#44; and regenerate the lockfile from a trusted registry if nobody can explain the change&#46;

Showing 1 of 1 findings and 0 of 0 analysis gaps.
Full escaped details are available in the workflow artifact capdelta&#45;report&#46;json.
