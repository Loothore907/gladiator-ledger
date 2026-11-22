# Epoch AI data

`eci_scores.csv` is an unmodified copy of `epoch_capabilities_index/eci_scores.csv` from Epoch AI's Benchmarking
Hub download (`https://epoch.ai/data/benchmark_data.zip`), retrieved on 2026-11-22. It holds the Epoch Capabilities
Index: one combined score per model, with a confidence interval.

Ledger uses it for one thing: suggesting an opponent that scores close to a model you name
(`uv run ledger opponents <model>`). Ledger never ranks models by it.

## Licence and credit
Epoch AI's data is free to use, distribute, and reproduce provided the source and authors are credited under the
[Creative Commons Attribution 4.0 licence](https://creativecommons.org/licenses/by/4.0/).

> Epoch AI, 'Capabilities & benchmarking'. Published online at epoch.ai. Retrieved from
> 'https://epoch.ai/benchmarks' [online resource].

The index is computed by Epoch from many benchmarks, some run by Epoch and some by others. Only the index file is
included here; none of the individual benchmark files are.
