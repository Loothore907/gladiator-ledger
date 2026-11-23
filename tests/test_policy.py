from ledger import cli, policy


def fault(name, attempts_with, kind="decision", kind_of=None):
    return {"fault": name, "kind": kind, "kind_of": kind_of, "attempts_with": attempts_with, "times": attempts_with}


def test_the_same_fault_is_not_equally_serious_on_every_task():
    # paying twice breaks a business; paging the on-call twice is an annoyance
    assert policy.level_of("gladiator/refund-queue", "duplicate effect", None, "personal") == "unforgivable"
    assert policy.level_of("gladiator/incident-triage", "duplicate effect", None, "personal") == "minor"
    assert policy.level_of("gladiator/incident-triage", "duplicate effect", None, "enterprise") == "serious"
    # a wrong decision on a money task is unforgivable for a business, serious for one person
    assert policy.level_of("gladiator/refund-queue", "wrong decision", None, "enterprise") == "unforgivable"
    assert policy.level_of("gladiator/refund-queue", "wrong decision", None, "personal") == "serious"


def test_a_mix_up_takes_the_level_of_the_fault_it_is_a_kind_of_and_the_reader_can_overrule_anything():
    assert policy.level_of("t/x", "should close, did escalate", "wrong decision", "personal") == "serious"
    mine = {"should close, did escalate": "unforgivable", "duplicate effect": "minor"}
    assert policy.level_of("t/x", "should close, did escalate", "wrong decision", "personal", mine) == "unforgivable"
    assert policy.level_of("gladiator/refund-queue", "duplicate effect", None, "enterprise", mine) == "minor"
    assert policy.level_of("t/x", "a fault nobody has classified", None, "personal") == "serious"


def test_one_unforgivable_attempt_marks_a_model_unfit_and_the_count_is_shown():
    row = {"attempts": 54, "passed": 54}
    got = policy.assess("t/x", row, [fault("duplicate effect", 1, kind="trap")], "personal")
    assert got["fit"] is False
    assert got["reasons"] == ["duplicate effect (unforgivable) in 1 of 54 attempts"]
    assert policy.assess("t/x", row, [fault("duplicate effect", 0, kind="trap")], "personal")["fit"] is True


def test_a_serious_fault_is_tolerated_when_rare_and_a_minor_one_never_decides():
    row = {"attempts": 50, "passed": 50}
    assert policy.assess("t/x", row, [fault("wrong decision", 5)], "personal")["fit"] is True  # 10% allowed
    assert policy.assess("t/x", row, [fault("wrong decision", 6)], "personal")["fit"] is False
    assert policy.assess("t/x", row, [fault("wrong decision", 2)], "enterprise")["fit"] is False  # 2% allowed
    assert policy.assess("t/x", row, [fault("left undone", 40)], "personal")["fit"] is True  # minor
    # a mix-up explains a wrong decision; it does not count against the model a second time
    both = [fault("wrong decision", 5), fault("should a, did b", 5, kind="mix-up", kind_of="wrong decision")]
    assert policy.assess("t/x", row, both, "personal")["fit"] is True


def test_the_pass_bar_and_thin_evidence():
    assert policy.assess("t/x", {"attempts": 10, "passed": 7}, [], "personal")["fit"] is False
    assert policy.assess("t/x", {"attempts": 10, "passed": 8}, [], "personal")["fit"] is True
    assert policy.assess("t/x", {"attempts": 10, "passed": 8}, [], "enterprise")["fit"] is False  # bar 90%
    thin = policy.assess("t/x", {"attempts": 3, "passed": 3}, [], "personal")
    assert thin["fit"] is None and thin["thin"]  # too few attempts: neither fit nor unfit


def test_outcome_reads_the_head_to_head_through_fitness():
    def fit(a, b):
        return {"A": {"fit": a}, "B": {"fit": b}}

    won = {"a": "A", "b": "B", "better": "B", "verdict": "better"}
    assert cli.outcome(won, fit(True, True)) == ("use", "Use B: both are fit for this task and it did it better.")
    code, line = cli.outcome(won, fit(True, False))
    assert code == "only one fit" and line == "B did it better head to head, but only A is fit for this task."
    code, line = cli.outcome(won, fit(False, False))
    assert code == "neither fit" and "not the same as fit" in line
    level = {"a": "A", "b": "B", "better": None, "verdict": "no real difference shown"}
    assert cli.outcome(level, fit(True, True))[0] == "both fit"
    assert cli.outcome(level, fit(None, True))[0] == "too few attempts"
    lean = {"a": "A", "b": "B", "better": "A", "verdict": "leaning"}
    assert "not settled" in cli.outcome(lean, fit(True, True))[1]


def test_verdict_without_a_profile_is_unchanged_and_with_one_adds_fitness():
    store = "data/ledger.rl"
    a, b = "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"
    plain = cli.verdict(store, "refund-queue", a, b)
    assert "fit" not in plain and "headline" not in plain
    judged = cli.verdict(store, "refund-queue", a, b, profile="personal")
    assert {k: v for k, v in judged.items() if k in plain} == plain  # the head to head itself does not move
    assert set(judged["fit"]) == {a, b} and judged["headline"]
    # fitness counts every attempt the model made on the task, not only those against this opponent
    assert judged["fit"][a]["attempts"] > plain["models"][a]["attempts"]
    # the reader's own rule changes the answer: making "acted without reading" unforgivable makes Haiku unfit here
    strict = cli.verdict(
        store, "refund-queue", a, b, profile="personal", overrides={"acted without reading": "unforgivable"}
    )
    assert strict["fit"][a]["fit"] is False and strict["outcome"] == "neither fit"
