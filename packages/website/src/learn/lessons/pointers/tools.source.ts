// Lesson 8's tools.ts: `lookup`, a tool whose answer is long (one of three
// articles the file holds), and the kernel's `ReadResult` with its handler,
// the tool a model reads on with from a pointer. The learner edits all of
// it; the page runs it as written, and program.test.ts compiles and runs it.

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = `import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { ReadResult, readResult } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** What the learner edits: the articles, the tools and their handlers. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = `// What lookup answers with: three articles, each long on purpose.
const articles = {
  tides: \`Tides are the regular rise and fall of the sea along a coast. Most shores see two high
waters and two low waters in a little under 25 hours, so each high tide comes about 50 minutes
later than the one the day before. The pattern has been recorded for thousands of years, and
sailors planned their voyages around it long before anyone could explain it.

The moon causes most of the tide. Its gravity pulls harder on the side of the Earth that faces
it than on the far side, and the difference stretches the oceans into two bulges, one under the
moon and one opposite it. The far bulge is there because the moon pulls the solid Earth away
from the water behind it. As the Earth turns, a place on the coast passes through both bulges,
which is why there are two high tides a day and not one.

The sun adds a pull of its own, a little less than half as strong as the moon's. At new moon and
full moon the two line up and their effects add: these are spring tides, with the highest high
waters and the lowest low waters. At the quarter moons they work at right angles and partly
cancel, which gives the weaker neap tides. The cycle from spring to neap and back takes about
two weeks.

The shape of the coast changes everything. In the open ocean the tide is well under a metre
high, but a bay shaped like a funnel can pile the water up many times over. The Bay of Fundy in
Canada has the largest range in the world, more than 15 metres in places, while much of the
Mediterranean sees only a few centimetres. Some rivers carry a tidal bore, a wave that runs
upstream.

Life on the shore is built around the tide. The strip between high and low water is flooded and
dried twice a day, and the animals there, such as barnacles, mussels and limpets, close up or
cling on to survive the dry hours. Many fish and crabs time their breeding to spring tides, and
wading birds feed on the mud flats that low water uncovers.

People use the tide as well. Harbours publish tide tables years ahead, because the motions of
the moon and the sun are known so precisely. Ships with a deep draught wait for high water to
cross a bar, and tidal power stations, such as the one on the Rance in France, run turbines on
the flow in and out of an estuary. The tides also slow the spin of the Earth: a day is about two
thousandths of a second longer than it was a century ago.\`,
  volcanoes: \`A volcano is an opening in the crust of the Earth where molten rock, ash and gas
escape from below. The molten rock is called magma while it is underground and lava once it
reaches the surface. Over many eruptions the lava and ash pile up around the opening, and that
is how the mountain itself is built. About 1,350 volcanoes on land are counted as potentially
active today.

Most volcanoes sit along the edges of the plates that make up the crust. Where one plate slides
under another, the sinking rock releases water, the mantle above it melts, and the magma rises:
this is why a ring of volcanoes surrounds the Pacific Ocean. Where two plates pull apart, as
along the middle of the Atlantic, magma wells up to fill the gap. A few, like those of Hawaii,
stand over hot spots far from any edge.

The shape of a volcano depends on its lava. Runny lava flows a long way before it cools and
builds a broad shield volcano with gentle slopes, such as Mauna Loa. Thick, sticky lava traps
gas, erupts in bursts and builds a steep cone out of layers of ash and lava, such as Mount
Fuji. When a magma chamber empties, the ground above it can collapse and leave a wide basin
called a caldera.

Eruptions range from quiet to violent. In a quiet one, lava pours out in rivers that people can
often walk away from. In a violent one, gas trapped in thick magma blows it apart, and a column
of ash climbs tens of kilometres into the sky. The deadliest hazard is the pyroclastic flow, a
cloud of hot gas and rock that races down the slope faster than a car. Flows of this kind buried
Pompeii and Herculaneum in the year 79.

Large eruptions change the weather far away. Ash and sulphur gas high in the air reflect
sunlight, and the whole planet cools for a year or two. After Tambora erupted in Indonesia in
1815, crops failed across Europe and North America in what was called the year without a
summer. The eruption of Pinatubo in 1991 lowered the average temperature of the Earth by about
half a degree.

People still live beside volcanoes, for good reasons. Volcanic soil is rich in minerals and
grows fine crops, and hot rock near the surface gives heat and electricity, as in Iceland.
Scientists watch active volcanoes with seismometers, gas sensors and satellites: small
earthquakes, a swelling of the ground and a change in the gases often come before an eruption,
and the warning has saved many lives.\`,
  honeybees: \`A honeybee colony is a single family of tens of thousands of bees. In summer a
strong hive holds one queen, a few hundred male drones and up to 60,000 female workers. No bee
can live for long alone: the colony feeds, builds, defends and reproduces as one body, and
beekeepers often speak of the hive, not the bee, as the animal. A hive that loses its queen
raises a new one within weeks, or dies out.

The queen is the mother of the whole hive. She mates in the air during her first weeks and then
stays inside, where she can lay more than 1,500 eggs a day in early summer. An egg that she
fertilises becomes a female, and one that she does not becomes a drone. Whether a female larva
grows into a worker or a new queen depends on its food: a future queen is fed royal jelly for
the whole of her growth.

A worker changes jobs as she ages. In her first days she cleans cells and feeds the larvae, then
she builds comb from the wax that her own body makes, stores nectar and guards the entrance.
Only in the last weeks of her life does she fly out to forage. A summer worker lives about six
weeks, while one born in autumn can live through the winter.

Foragers tell each other where the flowers are by dancing. A bee that has found a good patch
walks a figure of eight on the comb and waggles her body on the middle stretch. The angle of
that stretch from straight up gives the direction of the flowers relative to the sun, and the
time she spends waggling gives the distance. A researcher who worked out this code was given a
Nobel Prize for it in 1973.

Honey is the food of the colony for the winter. Workers collect nectar, add enzymes to it and
fan it with their wings until most of the water has gone, then seal each full cell with wax. A
hive may need 20 kilograms or more to last until spring. In the cold the bees do not sleep:
they form a tight cluster around the queen and shiver their flight muscles to keep its centre
warm.

Bees matter far beyond the hive. As they move from flower to flower they carry pollen, and many
fruits, nuts and vegetables give a much smaller crop without them. Colonies today face mites
such as varroa, diseases, pesticides and a shortage of flowers, and beekeepers in many countries
lose a large share of their hives each winter. Planting flowers that bloom at different times of
the year helps.\`,
}

// The tools: what each is called, what it does, what it takes and returns.
// lookup answers with a whole article: a result too long to send in every prompt.
const lookup = Tool.make("lookup", {
  description: "Look up an article. The topics are tides, volcanoes and honeybees.",
  parameters: Schema.Struct({ topic: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  // A failure goes back to the model as the tool's answer.
  failureMode: "return",
})

// ReadResult is the kernel's tool: it reads a part of a stored result, from the place a pointer
// names. A program whose memory sends pointers offers it beside its own tools.
export const tools = Toolkit.make(lookup, ReadResult)

// What each tool does when it is called. It runs here, in your browser.
export const toolsLive = tools.toLayer({
  lookup: ({ topic }) => {
    const name = topic.trim().toLowerCase()
    const article = Object.hasOwn(articles, name) ? articles[name] : undefined
    // A topic there is no article on is a failure the model reads: it names the three there are.
    return article === undefined
      ? Effect.fail(\`No article on "\${topic}". The topics are tides, volcanoes and honeybees.\`)
      : Effect.succeed(article)
  },
  // The kernel's handler: it reads the result from the journal of the turn its call runs in.
  readResult,
})`

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: the articles typed as texts by topic. */
export const toolsModuleOf = (tools: string): string =>
  `${TOOLS_HEADER}${tools.replace("const articles = {", "const articles: Record<string, string> = {")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
