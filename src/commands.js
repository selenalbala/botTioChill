require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("panel_tiradas")
    .setDescription("Crea o actualiza el panel con el botón +1 tirada")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("mis_tiradas")
    .setDescription("Consulta tus tiradas, tu meta y cuándo puedes hacer la siguiente"),

  new SlashCommandBuilder()
    .setName("tiradas_usuario")
    .setDescription("Consulta las tiradas de un usuario. Solo roles autorizados pueden consultar a otros.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuario a consultar")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("total_tiradas")
    .setDescription("Muestra el total semanal y mensual de meta"),

  new SlashCommandBuilder()
    .setName("tiradas_mes")
    .setDescription("Consulta tiradas y meta de un mes concreto")
    .addIntegerOption(option =>
      option
        .setName("anio")
        .setDescription("Año, por ejemplo 2026")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("mes")
        .setDescription("Mes del 1 al 12")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Opcional: usuario concreto")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("tiradas_semana")
    .setDescription("Consulta tiradas y meta de una semana concreta")
    .addIntegerOption(option =>
      option
        .setName("anio")
        .setDescription("Año ISO, por ejemplo 2026")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("semana")
        .setDescription("Semana ISO del 1 al 53")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Opcional: usuario concreto")
        .setRequired(false)
    )
];

async function registerCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    throw new Error("Faltan DISCORD_TOKEN, CLIENT_ID o GUILD_ID en el .env.");
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands.map(command => command.toJSON()) }
  );

  console.log("Comandos registrados correctamente.");
}

registerCommands().catch(error => {
  console.error(error);
  process.exit(1);
});
