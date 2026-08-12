--
-- A container Dockplane built keeps its identity when Docker replaces it.
--
-- Nothing is added for the identity itself: containers.id is already an
-- immutable primary key, and the container carries it as a label. What is added
-- is somewhere to record that two containers claimed the same one, which is a
-- state a person has to resolve rather than something to guess at.
--
ALTER TABLE "containers" ADD COLUMN "identity_conflict" jsonb;
