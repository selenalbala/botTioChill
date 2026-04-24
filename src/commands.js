require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("total")
    .setDescription("Muestra el total general de tiradas"),

  new SlashCommandBuilder()
    .setName("tiradas_usuario")
    .setDescription("Muestra las tiradas de un usuario")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("tiradas_mes")
    .setDescription("Muestra las tiradas de un mes")
    .addIntegerOption(option =>
      option.setName("anio").setDescription("Año").setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("mes").setDescription("Mes (1-12)").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("tiradas_semana")
    .setDescription("Muestra las tiradas de una semana ISO")
    .addIntegerOption(option =>
      option.setName("anio").setDescription("Año").setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("semana").setDescription("Semana ISO").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("tiradas_rango")
    .setDescription("Muestra las tiradas entre dos fechas")
    .addStringOption(option =>
      option.setName("desde").setDescription("YYYY-MM-DD").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("hasta").setDescription("YYYY-MM-DD").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("top_tiradas")
    .setDescription("Muestra el top de tiradas")
    .addIntegerOption(option =>
      option.setName("limite").setDescription("Cantidad de usuarios").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("exportar_excel")
    .setDescription("Genera un Excel con todas las tiradas"),

  new SlashCommandBuilder()
    .setName("informe_semana")
    .setDescription("Envía manualmente el informe semanal al canal configurado")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands.map(command => command.toJSON()) }
  );

  console.log("Comandos registrados correctamente.");
}

registerCommands().catch(console.error);