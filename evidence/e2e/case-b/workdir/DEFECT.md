# Reported defect (the copy the agent receives is patched with this)

Symptom, as a user would report it:

    $ ./run-tests.sh
    ok   add accumulates
    ok   reset clears
    FAIL merge clears source: got 2 want 0
    exit=1

Merging a counter into another must leave the source empty. Our pass rewrites two
independent counting regions into one and relies on `mergeFrom` consuming the source;
after the merge the source still reports its old count, so the module-level total is
counted twice on the next sweep.

Reproduce: `./run-tests.sh` in this directory.
